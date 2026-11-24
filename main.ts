// Pump.fun paper-trading bot (paper money only, no real funds).
//
// Protocol: the grader speaks JSON lines on stdin. The first line is a
// hello carrying a seed, starting cash, limits, latency and fees. After
// that comes one batch per slot, in slot order. For every batch the bot
// prints exactly one reply line carrying its orders, and nothing else
// on stdout. A closing message makes the bot exit.
//
// Strategy in one paragraph: keep a short-window and a longer-window
// average price per coin from the marks, buy only when the short average
// sits clearly above the long average and recent buys outweigh recent
// sells, size each buy near 0.25 SOL, and sell a whole position on a
// take-profit, a stop-loss, or a short-below-long reversal. Positions
// are always reconciled from the account state in each batch, never
// from the bot's memory of its own orders, because orders can be
// rejected or fail.
//
// Money is always BigInt lamports. Prices and ratios are plain numbers.
// Randomness, where needed at all, comes only from the hello seed.

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Small deterministic generator seeded from the hello seed.
// ---------------------------------------------------------------------------

function makeRng(seedText: string): () => number {
  // FNV-1a hash of the seed text into a 32-bit state, then mulberry32.
  let state = 2166136261 >>> 0;
  for (let i = 0; i < seedText.length; i++) {
    state ^= seedText.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Loose field access: the brief describes the protocol in words, so accept
// the plausible spellings of each field instead of trusting one exact key.
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function isObj(v: unknown): v is AnyObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(obj: AnyObj, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return v.toString();
  return undefined;
}

function asBig(v: unknown): bigint | undefined {
  const t = asText(v);
  if (t === undefined) return undefined;
  try {
    const cleaned = t.trim();
    if (!/^-?\d+$/.test(cleaned)) return undefined;
    return BigInt(cleaned);
  } catch {
    return undefined;
  }
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = asText(v);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function msgType(m: AnyObj): string {
  const t = asText(pick(m, ["type", "kind", "messageType", "msgType"])) ?? "";
  return t.toLowerCase();
}

// ---------------------------------------------------------------------------
// Configuration, filled in from the hello message.
// ---------------------------------------------------------------------------

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BUY_SIZE_LAMPORTS = 250_000_000n; // about 0.25 SOL per buy
const CASH_RESERVE_LAMPORTS = 100_000_000n; // keep about 0.1 SOL unspent
const SLIPPAGE_BPS = 500;
const MAX_ORDERS_PER_REPLY = 16;

const cfg = {
  seed: "0",
  maxPositions: 5,
  maxBuyFractionOfRealReserve: 0.02, // conservative default under any small cap
  latencySlots: 0,
  started: false,
};

let rng = makeRng("0");
let orderCounter = 0;

function nextClientId(prefix: string): string {
  orderCounter += 1;
  // Letters, digits and hyphens only, never starting with an underscore,
  // unique across the run by construction.
  return `${prefix}-${orderCounter}`;
}

// ---------------------------------------------------------------------------
// Per-coin state, built from marks and trade events.
// ---------------------------------------------------------------------------

interface TradeTick {
  slot: number;
  buySol: number; // SOL volume of buys in this tick
  sellSol: number; // SOL volume of sells in this tick
}

interface CoinState {
  mint: string;
  firstPrice: number | undefined;
  firstSeenSlot: number;
  completed: boolean;
  prices: number[]; // mark prices, oldest first, capped
  trades: TradeTick[]; // recent trade ticks, oldest first
  tradeCount: number;
  cooldownUntilSlot: number;
}

const coins = new Map<string, CoinState>();

function coinState(mint: string, slot: number): CoinState {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      firstPrice: undefined,
      firstSeenSlot: slot,
      completed: false,
      prices: [],
      trades: [],
      tradeCount: 0,
      cooldownUntilSlot: -1,
    };
    coins.set(mint, c);
  }
  return c;
}

function avg(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

const SHORT_WINDOW = 4; // last 4 marks
const LONG_WINDOW = 12; // last 12 marks
const MIN_LONG_SAMPLES = 6; // need this many marks before judging a trend
const MIN_TRADES = 6; // need this many trades before buying a coin
const MOMENTUM_EDGE = 1.03; // short average must beat long average by 3%
const BUY_FLOW_RATIO = 1.2; // recent buy SOL must beat recent sell SOL by 20%
const MAX_RUN_UP = 1.5; // never chase more than ~50% above first-seen price
const TAKE_PROFIT = 1.28; // sell near +28% above entry
const STOP_LOSS = 0.88; // sell near -12% below entry
const COOLDOWN_SLOTS = 90; // do not rebuy a coin for a while after selling it
const MAX_BUYS_PER_BATCH = 3; // spread entries; breadth comes from many slots
const TRADE_WINDOW_SLOTS = 60; // recent-flow window, counted in slots

// ---------------------------------------------------------------------------
// Positions, reconciled from the account state of each batch.
// ---------------------------------------------------------------------------

interface Position {
  mint: string;
  amount: bigint; // token amount (raw units)
  cost: bigint; // lamports paid
  entryPrice: number; // lamports per token unit, derived from cost / amount
}

// Orders already sent but not yet visible in the account state: orders
// resolve a few slots after the reply that sent them, so the next batch
// still shows the old account. Without this memory the bot would send a
// second buy for the same coin on the next slot, or sell the same position
// twice. An entry expires after the latency plus a grace period; after
// that, if the account still shows no change, the order presumably failed
// or was rejected and a retry is allowed.
const pending = new Map<string, { side: string; slot: number }>();
const PENDING_GRACE_SLOTS = 15;

function pendingRecent(mint: string, side: string, slot: number): boolean {
  const p = pending.get(mint);
  if (!p || p.side !== side) return false;
  return slot - p.slot <= cfg.latencySlots + PENDING_GRACE_SLOTS;
}

const positions = new Map<string, Position>();
// Entry prices remembered across batches for coins we already hold, so a
// batch whose account state is thin still has an entry to compare against.
const entryByMint = new Map<string, number>();

function reconcilePositions(account: AnyObj | undefined, marks: Map<string, number>): void {
  positions.clear();
  if (!account) return;
  const list = asArray(pick(account, ["positions", "openPositions", "holdings"]));
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const mint = asText(pick(raw, ["mint", "coin", "address", "tokenMint", "mintAddress"]));
    const amount = asBig(pick(raw, ["token_amount"]));
    const cost = asBig(pick(raw, ["cost_lamports"]));
    if (!mint || amount === undefined || amount <= 0n) continue;
    // Entry price: prefer the mark price when the position first appears,
    // because it is always in the same units as later mark prices. The
    // cost-over-amount ratio is only a fallback, for a batch with no mark:
    // it is exact only if the account's token units match the reserves'.
    let entry: number | undefined = entryByMint.get(mint) ?? marks.get(mint);
    if (entry === undefined || !Number.isFinite(entry) || entry <= 0) {
      if (cost !== undefined && amount > 0n) {
        const derived = Number(cost) / Number(amount);
        if (Number.isFinite(derived) && derived > 0) entry = derived;
      }
    }
    if (entry === undefined || !Number.isFinite(entry) || entry <= 0) continue;
    entryByMint.set(mint, entry);
    positions.set(mint, { mint, amount, cost: cost ?? 0n, entryPrice: entry });
    // The buy has landed in the account, so it is no longer pending.
    const p = pending.get(mint);
    if (p && p.side === "buy") pending.delete(mint);
  }
  // A position that is gone was sold, so its pending sell is done too.
  for (const [mint, p] of [...pending.entries()]) {
    if (p.side === "sell" && !positions.has(mint)) pending.delete(mint);
  }
}

// ---------------------------------------------------------------------------
// Hello handling.
// ---------------------------------------------------------------------------

function handleHello(m: AnyObj): void {
  const seed = asText(pick(m, ["seed", "rngSeed"])) ?? "0";
  cfg.seed = seed;
  rng = makeRng(seed);
  // Touch the generator once so the seed genuinely drives the stream, even
  // though ordering below is deterministic by score and mint.
  void rng();

  const limits = pick(m, ["caps", "limits", "tradingLimits", "constraints"]);
  const limObj = isObj(limits) ? limits : m;

  const maxPos = asNum(pick(limObj, ["max_open_positions"]));
  if (maxPos !== undefined && maxPos > 0) cfg.maxPositions = Math.floor(maxPos);

  const bps = asNum(pick(limObj, ["max_order_bps_of_real_reserve"]));
  if (bps !== undefined && bps > 0 && bps <= 10000) {
    // The cap is in basis points, not a fraction: 500 bps means 5%.
    const frac = bps / 10000;
    // Stay a little inside the stated cap so rounding can never breach it.
    cfg.maxBuyFractionOfRealReserve = Math.min(frac * 0.9, frac);
  }

  const latency = asNum(pick(m, ["latency_slots"]));
  if (latency !== undefined && latency >= 0) cfg.latencySlots = Math.floor(latency);

  cfg.started = true;
}

// ---------------------------------------------------------------------------
// Batch handling: update coin state from events and marks, then decide.
// ---------------------------------------------------------------------------

function priceFromMark(mark: AnyObj): { mint: string; price: number; realToken: number | undefined; realQuote: number | undefined } | undefined {
  const mint = asText(pick(mark, ["mint", "coin", "address", "tokenMint", "mintAddress"]));
  if (!mint) return undefined;
  const vToken = asNum(pick(mark, ["virtual_token_reserves"]));
  const vQuote = asNum(pick(mark, ["virtual_quote_reserves"]));
  if (vToken === undefined || vQuote === undefined || vToken <= 0 || vQuote < 0) return undefined;
  const realToken = asNum(pick(mark, ["real_token_reserves"]));
  const realQuote = asNum(pick(mark, ["real_quote_reserves"]));
  return { mint, price: vQuote / vToken, realToken, realQuote };
}

function handleBatch(m: AnyObj): AnyObj {
  const seqRaw = pick(m, ["seq", "sequence", "sequenceNumber"]);
  const seq = asNum(seqRaw) ?? 0;
  const slot = asNum(pick(m, ["slot", "slotNumber"])) ?? 0;

  // Expire stale pending orders so a failed or rejected order can be retried.
  for (const [mint, p] of [...pending.entries()]) {
    if (slot - p.slot > cfg.latencySlots + PENDING_GRACE_SLOTS) pending.delete(mint);
  }

  // --- Events: creations, trades, completions. ---
  const events = asArray(pick(m, ["events", "chainEvents", "slotEvents"]));
  for (const raw of events) {
    if (!isObj(raw)) continue;
    const kind = (asText(pick(raw, ["type", "kind", "eventType", "event"])) ?? "").toLowerCase();
    const mint = asText(pick(raw, ["mint", "coin", "address", "tokenMint", "mintAddress"]));
    if (!mint) continue;
    const c = coinState(mint, slot);
    if (kind.includes("creat") || kind.includes("newcoin") || kind.includes("mint")) {
      c.completed = false;
    } else if (kind.includes("complet") || kind.includes("migrat") || kind.includes("graduat") || kind.includes("finish")) {
      c.completed = true;
    } else if (kind.includes("trade") || kind.includes("swap") || kind.includes("buy") || kind.includes("sell")) {
      const solAmt = asNum(pick(raw, ["sol_amount"]));
      const isBuyRaw = pick(raw, ["is_buy"]);
      const isBuy =
        asBool(isBuyRaw) ||
        (typeof isBuyRaw === "string" && isBuyRaw.toLowerCase() === "buy");
      const sol = solAmt !== undefined && Number.isFinite(solAmt) ? Math.abs(solAmt) : 0;
      // Instruction names such as "buy" / "sell" are a fallback signal.
      const instr = (asText(pick(raw, ["ix_name"])) ?? "").toLowerCase();
      const buyByInstr = instr === "buy";
      const sellByInstr = instr === "sell";
      const buy = buyByInstr ? true : sellByInstr ? false : isBuy;
      c.tradeCount += 1;
      c.trades.push({ slot, buySol: buy ? sol : 0, sellSol: buy ? 0 : sol });
      if (c.trades.length > 200) c.trades.splice(0, c.trades.length - 200);
    }
  }

  // --- Marks: the source of current prices. ---
  const marks = asArray(pick(m, ["marks", "prices", "markPrices", "mark"]));
  const priceByMint = new Map<string, number>();
  const realQuoteByMint = new Map<string, number>();
  for (const raw of marks) {
    if (!isObj(raw)) continue;
    const parsed = priceFromMark(raw);
    if (!parsed) continue;
    priceByMint.set(parsed.mint, parsed.price);
    if (parsed.realQuote !== undefined) realQuoteByMint.set(parsed.mint, parsed.realQuote);
    const c = coinState(parsed.mint, slot);
    if (c.firstPrice === undefined) c.firstPrice = parsed.price;
    c.prices.push(parsed.price);
    if (c.prices.length > LONG_WINDOW) c.prices.splice(0, c.prices.length - LONG_WINDOW);
  }

  // Prune trade flow to the recent slot window.
  for (const c of coins.values()) {
    while (c.trades.length > 0 && slot - c.trades[0].slot > TRADE_WINDOW_SLOTS) c.trades.shift();
  }

  // --- Account state: trust it over our memory of orders. ---
  const accountRaw = pick(m, ["account", "accountState", "state", "portfolio"]);
  const account = isObj(accountRaw) ? accountRaw : undefined;
  reconcilePositions(account, priceByMint);
  let cash = 0n;
  if (account) {
    const cashRaw = asBig(pick(account, ["cash_lamports"]));
    if (cashRaw !== undefined) cash = cashRaw;
  }

  // Fills are read for completeness (a rejected order leaves no position,
  // which reconcilePositions already reflects). Nothing else is needed here.
  void asArray(pick(m, ["fills", "orderFills", "resolvedOrders"]));

  // --- Decide sells first: free slots and lock in exits before buying. ---
  type Order = AnyObj;
  const orders: Order[] = [];

  for (const pos of [...positions.values()].sort((a, b) => (a.mint < b.mint ? -1 : 1))) {
    const price = priceByMint.get(pos.mint);
    if (price === undefined || price <= 0) continue;
    if (pendingRecent(pos.mint, "sell", slot)) continue; // sell already in flight
    const c = coins.get(pos.mint);
    const shortAvg = c ? avg(c.prices.slice(-SHORT_WINDOW)) : undefined;
    const longAvg = c ? avg(c.prices) : undefined;
    const ratio = price / pos.entryPrice;
    let sell = false;
    if (ratio >= TAKE_PROFIT) sell = true; // about +28%
    else if (ratio <= STOP_LOSS) sell = true; // about -12%
    else if (
      shortAvg !== undefined &&
      longAvg !== undefined &&
      c !== undefined &&
      c.prices.length >= MIN_LONG_SAMPLES &&
      shortAvg < longAvg
    ) {
      sell = true; // trend turned back down after we bought
    }
    if (sell) {
      orders.push({
        side: "sell",
        client_id: nextClientId("s"),
        mint: pos.mint,
        token_amount: pos.amount.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pending.set(pos.mint, { side: "sell", slot });
      const coin = coins.get(pos.mint);
      if (coin) coin.cooldownUntilSlot = slot + COOLDOWN_SLOTS;
      positions.delete(pos.mint);
    }
  }

  // --- Decide buys. ---
  const freeSlots = cfg.maxPositions - positions.size;
  if (freeSlots > 0 && cash > CASH_RESERVE_LAMPORTS + BUY_SIZE_LAMPORTS) {
    interface Candidate {
      mint: string;
      score: number;
      buySize: bigint;
    }
    const candidates: Candidate[] = [];
    for (const c of coins.values()) {
      if (c.completed) continue;
      if (positions.has(c.mint)) continue;
      if (pendingRecent(c.mint, "buy", slot)) continue; // buy already in flight
      if (slot < c.cooldownUntilSlot) continue;
      const price = priceByMint.get(c.mint);
      if (price === undefined || price <= 0) continue;
      if (c.prices.length < MIN_LONG_SAMPLES) continue;
      if (c.tradeCount < MIN_TRADES) continue;
      const shortAvg = avg(c.prices.slice(-SHORT_WINDOW));
      const longAvg = avg(c.prices);
      if (shortAvg === undefined || longAvg === undefined || longAvg <= 0) continue;
      if (shortAvg < longAvg * MOMENTUM_EDGE) continue;
      // Do not buy a coin that is already rolling over: the current price
      // must still be holding near its short average. Without this, a
      // stale long average can make a falling coin look like a buy.
      if (price < shortAvg * 0.98) continue;
      if (c.firstPrice !== undefined && price > c.firstPrice * MAX_RUN_UP) continue; // do not chase
      let buySol = 0;
      let sellSol = 0;
      for (const t of c.trades) {
        buySol += t.buySol;
        sellSol += t.sellSol;
      }
      if (buySol <= 0) continue;
      if (buySol < sellSol * BUY_FLOW_RATIO) continue;
      // Size: about 0.25 SOL, capped by the reserve cap and by cash.
      let size = BUY_SIZE_LAMPORTS;
      const realQuote = realQuoteByMint.get(c.mint);
      if (realQuote !== undefined && realQuote > 0) {
        const capLamports = BigInt(Math.floor(realQuote * cfg.maxBuyFractionOfRealReserve));
        if (capLamports > 0n && capLamports < size) size = capLamports;
      }
      const spendable = cash - CASH_RESERVE_LAMPORTS;
      if (size > spendable) size = spendable;
      if (size <= 0n) continue;
      const score = shortAvg / longAvg + buySol / (buySol + sellSol + 1e-9);
      candidates.push({ mint: c.mint, score, buySize: size });
    }
    // Strongest momentum first; mint breaks ties so the choice is stable.
    candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    let buys = 0;
    for (const cand of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (orders.length >= MAX_ORDERS_PER_REPLY) break;
      if (positions.size + buys >= cfg.maxPositions) break;
      if (cand.buySize > cash - CASH_RESERVE_LAMPORTS) continue;
      orders.push({
        side: "buy",
        client_id: nextClientId("b"),
        mint: cand.mint,
        quote_lamports: cand.buySize.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      pending.set(cand.mint, { side: "buy", slot });
      cash -= cand.buySize;
      buys += 1;
    }
  }

  return { type: "reply", seq, orders: orders.slice(0, MAX_ORDERS_PER_REPLY) };
}

// ---------------------------------------------------------------------------
// Main loop: one reply per batch, nothing else on stdout, never crash.
// ---------------------------------------------------------------------------

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // skip a line that cannot be understood, keep going
    }
    if (!isObj(parsed)) return;
    const t = msgType(parsed);
    try {
      if (t === "hello") {
        handleHello(parsed);
        return; // the hello gets no reply
      }
      if (t === "done" || t === "close" || t === "end" || t === "shutdown" || t === "goodbye") {
        process.exit(0);
        return;
      }
      if (t === "batch") {
        const reply = handleBatch(parsed);
        process.stdout.write(JSON.stringify(reply) + "\n");
        return;
      }
      // Unknown message kinds are ignored silently; only a batch earns a reply.
    } catch {
      // Never crash on bad input. If this was a batch, still answer it.
      if (t === "batch") {
        const seq = asNum(pick(parsed, ["seq", "sequence", "sequenceNumber"])) ?? 0;
        process.stdout.write(JSON.stringify({ type: "reply", seq, orders: [] }) + "\n");
      }
    }
  });
  rl.on("close", () => process.exit(0));
}

main();
