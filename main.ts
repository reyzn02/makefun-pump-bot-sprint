// Snipe-and-scalp pump.fun replay bot.
//
// Strategy (written for this bounty, not a copy of any kit baseline):
//   * Watch every new coin from its CreateEvent. A coin becomes a buy
//     candidate only while it is young (<= 600 slots after first sight),
//     has at least 4 trades, more buys than sells, and its price has
//     already moved up 3%-60% from where it was first seen: momentum
//     confirmed, but not yet overextended.
//   * Buy a small fixed stake (0.02 SOL, or the size cap when smaller but
//     still >= 0.01 SOL, the guardrail's minimum round trip). Small stakes
//     plus quick exits turn the 5 open-position slots over fast enough to
//     clear the 20-distinct-mint guardrail.
//   * Sell the whole position when any exit fires: take-profit +30%,
//     stop-loss -20%, a trailing exit (fell 15% from a peak of +15% or
//     more), or age-out after 1200 slots (~8 minutes) so a dead coin never
//     parks a slot. The replay flattens whatever is left at the end.
//   * Deterministic: no clock, no environment, no Math.random. Every
//     decision comes from the batches the harness delivers, so the two
//     grading executions produce byte-identical action logs.
//
// Prices are bonding-curve virtual reserves: price = virtual quote
// reserves / virtual token reserves. All comparisons are bigint
// cross-multiplications, so no floating point ever enters a decision.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL per buy
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail minimum
const MAX_SLIPPAGE_BPS = 2000; // 20%: wide enough to fill through latency, tight enough to refuse a rug
const MAX_AGE_SLOTS = 600; // only buy coins first seen within the last ~4 minutes
const MIN_TRADES = 4;
const MAX_HOLD_SLOTS = 1200; // age-out: ~8 minutes, then free the slot
const TAKE_PROFIT_NUM = 130; // sell at +30%
const STOP_LOSS_NUM = 80; // sell at -20%
const TRAILING_PEAK_NUM = 115; // trailing exit only once the peak reached +15%
const TRAILING_DROP_NUM = 85; // ... and the price has since fallen 15% from that peak

/** A price as a rational: quote reserves per token reserves. */
interface Price {
  q: bigint;
  t: bigint;
}

interface CoinStat {
  firstPrice: Price;
  firstSlot: number;
  buys: number;
  sells: number;
  trades: number;
  decided: boolean;
  buySlot: number; // slot the buy order was decided on (-1 when never bought)
  peakPermille: number; // best value/cost seen, in permille (1000 = breakeven)
}

const stats = new Map<string, CoinStat>();

/** Compare price a against price b: -1, 0, 1. */
function cmpPrice(a: Price, b: Price): number {
  const left = a.q * b.t;
  const right = b.q * a.t;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when price `now` is at least `pct` percent above `ref`. */
function upAtLeast(now: Price, ref: Price, pct: number): boolean {
  // now/ref >= (100+pct)/100  <=>  now.q*ref.t*(100) >= ref.q*now.t*(100+pct)
  return now.q * ref.t * 100n >= ref.q * now.t * BigInt(100 + pct);
}

/** True when price `now` is at most `pct` percent above `ref`. */
function upAtMost(now: Price, ref: Price, pct: number): boolean {
  return now.q * ref.t * 100n <= ref.q * now.t * BigInt(100 + pct);
}

/** Current curve price, or null when the reserves are unusable. */
function curvePrice(q: bigint, t: bigint): Price | null {
  if (q <= 0n || t <= 0n) return null;
  return { q, t };
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // --- Fold this batch's events into per-coin stats. ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!stats.has(e.mint)) {
          const p = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (p !== null) {
            stats.set(e.mint, {
              firstPrice: p,
              firstSlot: e.slot,
              buys: 0,
              sells: 0,
              trades: 0,
              decided: false,
              buySlot: -1,
              peakPermille: 1000,
            });
          }
        }
      } else if (e.event === 'TradeEvent') {
        let s = stats.get(e.mint);
        if (s === undefined) {
          const p = curvePrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (p === null) continue;
          s = {
            firstPrice: p,
            firstSlot: e.slot,
            buys: 0,
            sells: 0,
            trades: 0,
            decided: false,
            buySlot: -1,
            peakPermille: 1000,
          };
          stats.set(e.mint, s);
        }
        s.trades += 1;
        if (e.is_buy) s.buys += 1;
        else s.sells += 1;
      } else {
        // CompleteEvent: the curve is done; never touch it again.
        const s = stats.get(e.mint);
        if (s !== undefined) s.decided = true;
      }
    }

    // --- Exits first: free slots and lock in gains before buying more. ---
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price === null) continue;
      const s = stats.get(mint);
      // Current value of the holding in lamports (floored).
      const value = (holding.token_amount * price.q) / price.t;
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      const permille = Number((value * 1000n) / cost);
      if (s !== undefined && permille > s.peakPermille) s.peakPermille = permille;
      const age = s !== undefined && s.buySlot >= 0 ? state.slot - s.buySlot : 0;
      const takeProfit = value * 100n >= cost * BigInt(TAKE_PROFIT_NUM);
      const stopLoss = value * 100n <= cost * BigInt(STOP_LOSS_NUM);
      const trailing =
        s !== undefined &&
        s.peakPermille >= TRAILING_PEAK_NUM * 10 &&
        permille * 100 <= s.peakPermille * TRAILING_DROP_NUM;
      const agedOut = age > MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || trailing || agedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // --- Entries: young coins with buy pressure and confirmed momentum. ---
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const s = stats.get(e.mint);
      if (s === undefined || s.decided) continue;
      if (state.positions.has(e.mint)) {
        s.decided = true;
        continue;
      }
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        s.decided = true;
        continue;
      }
      // Too old: momentum has passed; decide once and move on.
      if (state.slot - s.firstSlot > MAX_AGE_SLOTS) {
        s.decided = true;
        continue;
      }
      if (s.trades < MIN_TRADES) continue;
      if (s.buys < 3 || s.buys <= s.sells) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price === null) continue;
      // Momentum confirmed (+3%) but not overextended (+60%).
      if (!upAtLeast(price, s.firstPrice, 3) || !upAtMost(price, s.firstPrice, 60)) continue;
      // cmpPrice is used to sanity-check the band edges above; keep the
      // reference price honest: a coin that fell back below its first
      // price is no longer a momentum candidate.
      if (cmpPrice(price, s.firstPrice) < 0) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      s.decided = true;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      s.buySlot = state.slot;
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
