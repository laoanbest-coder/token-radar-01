// radar-2: fitted token-launch model over the make.fun token-radar-01 snapshot.
// Everything here is a pure function of the snapshot: no clocks, no randomness, no network.
// The fit: ridge regression of log(market cap / TVL) on traded-token comps, target winsorised
// to [-6, 3]; the launch value of a pre-token protocol is its TVL times the fitted ratio,
// and the board ranks by expected value = token odds x fitted FDV.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  mcap_usd: number | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export const DAY_MS = 86400000;
export const MODEL_VERSION = 'radar-2';
export const RIDGE_LAMBDA = 10;
export const TARGET_LO = -6;
export const TARGET_HI = 3;

// ---------------------------------------------------------------- helpers

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function ageDays(p: Protocol, asOfMs: number): number | null {
  if (!p.listed_at) return null;
  const b = Date.parse(p.listed_at + 'T00:00:00Z');
  if (!Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((asOfMs - b) / DAY_MS));
}

export function growthClamped(p: Protocol): number {
  return clamp(p.change_7d ?? 0, -60, 120);
}

/** The snapshot's own rule for "records no token". Never claim a protocol "has none". */
export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's exclusion rule, without its TVL floor: versioned names, wrapped/staked
 *  products, exchange-named products, and categories that are not launchable protocols. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_NAME = /\b(wrapped|staked|staking)\b/i;

export function isRankable(p: Protocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_NAME.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** Traded comps for the fit: a positive market cap and positive TVL. One snapshot row
 *  (autofinance) records a market cap of -1 and is excluded here by the > 0 test. */
export function tradedComps(s: Snapshot): Protocol[] {
  return s.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

// ---------------------------------------------------------------- the fit

/** Feature names, in order. The category list is fixed so the fit is deterministic. */
export const CATEGORY_FEATURES = [
  'Dexs',
  'Lending',
  'Liquid Staking',
  'Bridge',
  'Yield',
  'RWA',
  'Derivatives',
  'CDP',
  'Restaking',
  'Yield Aggregator',
  'Risk Curators',
  'Onchain Capital Allocator',
  'Basis Trading',
] as const;

export const FEATURE_NAMES = [
  'intercept',
  'log10_tvl',
  'log1p_age_days',
  'growth_7d',
  'n_chains',
  'has_ethereum',
  'has_solana',
  ...CATEGORY_FEATURES.map((c) => `category_${c}`),
];

export function features(p: Protocol, asOfMs: number): number[] {
  const age = ageDays(p, asOfMs);
  const f: number[] = [
    1,
    Math.log10(Math.max(1, p.tvl_usd)),
    Math.log1p(age ?? 365),
    growthClamped(p) / 100,
    p.chains.length,
    p.chains.includes('Ethereum') ? 1 : 0,
    p.chains.includes('Solana') ? 1 : 0,
  ];
  for (const c of CATEGORY_FEATURES) f.push(p.category === c ? 1 : 0);
  return f;
}

export const targetOf = (p: Protocol): number =>
  clamp(Math.log((p.mcap_usd as number) / p.tvl_usd), TARGET_LO, TARGET_HI);

/** Solve A x = b by Gauss-Jordan with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (piv !== c) {
      const t = M[c];
      M[c] = M[piv];
      M[piv] = t;
    }
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error(`solveLinear: singular matrix at column ${c}`);
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r[n]);
}

/** Ridge regression: (X'X + lambda I) beta = X'y, intercept unpenalised. */
export function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const d = X[0].length;
  const A: number[][] = Array.from({ length: d }, () => Array(d).fill(0));
  const b: number[] = Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < d; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < d; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < d; j++) A[j][j] += lambda;
  return solveLinear(A, b);
}

export interface FitResult {
  version: string;
  lambda: number;
  comps_used: number;
  comps_total: number;
  target_winsor: [number, number];
  coefficients: Record<string, number>;
  feature_names: string[];
  /** Leave-one-out validation over the comps. */
  loo: { r2: number; median_abs_log_error: number; mean_abs_log_error: number };
  /** Deterministic 80/20 split: slug hash % 5 === 0 is the test set. */
  held_out: { n_test: number; r2: number; median_abs_log_error: number };
  /** Size-only ridge as a benchmark: log10 TVL alone. */
  size_only_loo: { r2: number; median_abs_log_error: number };
  median_log_ratio: number;
  median_ratio: number;
}

function slugHash(str: string): number {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function medianOf(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function looStats(
  comps: Protocol[],
  y: number[],
  asOfMs: number,
  fitFn: (train: Protocol[], trainY: number[]) => (p: Protocol) => number,
): { r2: number; median_abs_log_error: number; mean_abs_log_error: number } {
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((a, v) => a + (v - meanY) ** 2, 0);
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);
    const predict = fitFn(train, trainY);
    errs.push(y[i] - predict(comps[i]));
  }
  const ssRes = errs.reduce((a, e) => a + e * e, 0);
  return {
    r2: 1 - ssRes / ssTot,
    median_abs_log_error: medianOf(errs.map(Math.abs)),
    mean_abs_log_error: errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length,
  };
}

export function fitLaunchModel(s: Snapshot): FitResult {
  const asOfMs = Date.parse(s.as_of + 'T00:00:00Z');
  const comps = tradedComps(s);
  const y = comps.map(targetOf);
  const X = comps.map((p) => features(p, asOfMs));
  const beta = ridgeFit(X, y, RIDGE_LAMBDA);
  const coefficients: Record<string, number> = {};
  FEATURE_NAMES.forEach((n, i) => {
    coefficients[n] = beta[i];
  });

  const predictWith = (b: number[]) => (p: Protocol) =>
    features(p, asOfMs).reduce((a, v, j) => a + v * b[j], 0);

  const loo = looStats(comps, y, asOfMs, (train, trainY) =>
    predictWith(ridgeFit(train.map((p) => features(p, asOfMs)), trainY, RIDGE_LAMBDA)),
  );
  const sizeOnly = looStats(comps, y, asOfMs, (train, trainY) => {
    const b = ridgeFit(
      train.map((p) => [1, Math.log10(Math.max(1, p.tvl_usd))]),
      trainY,
      1,
    );
    return (p: Protocol) => b[0] + b[1] * Math.log10(Math.max(1, p.tvl_usd));
  });

  const test = comps.filter((p) => slugHash(p.slug) % 5 === 0);
  const train = comps.filter((p) => slugHash(p.slug) % 5 !== 0);
  const bTrain = ridgeFit(
    train.map((p) => features(p, asOfMs)),
    train.map(targetOf),
    RIDGE_LAMBDA,
  );
  const testErrs = test.map((p) => targetOf(p) - predictWith(bTrain)(p));
  const meanTest = test.reduce((a, p) => a + targetOf(p), 0) / test.length;
  const ssTotTest = test.reduce((a, p) => a + (targetOf(p) - meanTest) ** 2, 0);
  const heldOut = {
    n_test: test.length,
    r2: 1 - testErrs.reduce((a, e) => a + e * e, 0) / ssTotTest,
    median_abs_log_error: medianOf(testErrs.map(Math.abs)),
  };

  return {
    version: MODEL_VERSION,
    lambda: RIDGE_LAMBDA,
    comps_used: comps.length,
    comps_total: s.protocols.filter((p) => p.mcap_usd !== null).length,
    target_winsor: [TARGET_LO, TARGET_HI],
    coefficients,
    feature_names: [...FEATURE_NAMES],
    loo,
    held_out: heldOut,
    size_only_loo: sizeOnly,
    median_log_ratio: medianOf(y),
    median_ratio: Math.exp(medianOf(y)),
  };
}

export function predictLogRatio(p: Protocol, fit: FitResult, asOfMs: number): number {
  const x = features(p, asOfMs);
  return clamp(
    x.reduce((a, v, j) => a + v * fit.coefficients[fit.feature_names[j]], 0),
    TARGET_LO,
    TARGET_HI,
  );
}

export function contributions(p: Protocol, fit: FitResult, asOfMs: number): Record<string, number> {
  const x = features(p, asOfMs);
  const out: Record<string, number> = {};
  fit.feature_names.forEach((n, j) => {
    out[n] = x[j] * fit.coefficients[n];
  });
  return out;
}

// ---------------------------------------------------------------- token odds

export interface OddsModel {
  global_rate: number;
  n_protocols: number;
  age_bands: { lo: number; hi: number; n: number; rate: number; shrunk: number }[];
  category_rates: Record<string, { n: number; rate: number; shrunk: number }>;
  shrink_prior: number;
}

const AGE_BANDS: [number, number][] = [
  [0, 180],
  [180, 365],
  [365, 730],
  [730, 100000],
];

export function fitTokenOdds(s: Snapshot): OddsModel {
  const asOfMs = Date.parse(s.as_of + 'T00:00:00Z');
  const global = s.protocols.filter((p) => !isPreToken(p)).length / s.protocols.length;
  const prior = 20;
  const age_bands = AGE_BANDS.map(([lo, hi]) => {
    const grp = s.protocols.filter((p) => {
      const a = ageDays(p, asOfMs);
      return a !== null && a >= lo && a < hi;
    });
    const tok = grp.filter((p) => !isPreToken(p)).length;
    const rate = grp.length ? tok / grp.length : global;
    return {
      lo,
      hi,
      n: grp.length,
      rate,
      shrunk: (grp.length * rate + prior * global) / (grp.length + prior),
    };
  });
  const category_rates: OddsModel['category_rates'] = {};
  const cats = [...new Set(s.protocols.map((p) => p.category ?? 'Unknown'))];
  for (const c of cats) {
    const grp = s.protocols.filter((p) => (p.category ?? 'Unknown') === c);
    const tok = grp.filter((p) => !isPreToken(p)).length;
    const rate = grp.length ? tok / grp.length : global;
    category_rates[c] = {
      n: grp.length,
      rate,
      shrunk: (grp.length * rate + prior * global) / (grp.length + prior),
    };
  }
  return { global_rate: global, n_protocols: s.protocols.length, age_bands, category_rates, shrink_prior: prior };
}

export function tokenOdds(p: Protocol, odds: OddsModel, asOfMs: number): number {
  const age = ageDays(p, asOfMs);
  const band =
    odds.age_bands.find((b) => age !== null && age >= b.lo && age < b.hi) ??
    odds.age_bands[odds.age_bands.length - 1];
  const cat = odds.category_rates[p.category ?? 'Unknown'];
  const catShrunk = cat ? cat.shrunk : odds.global_rate;
  const raw = 0.5 * band.shrunk + 0.5 * catShrunk;
  return clamp(raw, 0.05, 0.9);
}

// ---------------------------------------------------------------- farm plans

/** Stated gas cost per transaction in USD, November 2026 typicals. See METHOD.md. */
export const GAS_USD: Record<string, number> = {
  Ethereum: 8.0,
  Arbitrum: 0.15,
  Optimism: 0.12,
  Base: 0.08,
  Binance: 0.15,
  Polygon: 0.05,
  Avalanche: 0.3,
  Solana: 0.01,
  Gnosis: 0.05,
  Fantom: 0.1,
  'zkSync Era': 0.2,
  Linea: 0.15,
  Scroll: 0.15,
  Blast: 0.1,
  Mantle: 0.08,
  Mode: 0.08,
  'Hyperliquid L1': 0.01,
  Bitcoin: 2.0,
  Tron: 1.0,
};
export const DEFAULT_GAS_USD = 0.5;
export const BRIDGE_FEE_USD = 2.0;

export function capitalTier(tvl: number): number {
  if (tvl < 50_000_000) return 50;
  if (tvl < 250_000_000) return 100;
  if (tvl < 1_000_000_000) return 150;
  return 250;
}

export function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 30;
  if (age < 730) return 45;
  return 60;
}

const CATEGORY_ACTION: Record<string, string> = {
  Dexs: 'Provide liquidity in the protocol’s main pool and keep the position in range for the full hold.',
  Lending: 'Borrow a small amount against the deposit so the position shows both sides of the market.',
  Yield: 'Restake the weekly rewards into the same vault instead of withdrawing them.',
  RWA: 'Hold the tokenised position through one full reporting cycle and keep the custody receipt.',
  Derivatives: 'Open one small hedged position on the protocol’s main market and close it before the hold ends.',
  'Liquid Staking': 'Keep the staked position through one full validator epoch and do not unstake early.',
  CDP: 'Mint a small amount of the protocol’s stable asset against the deposit and repay it before unwinding.',
  Bridge: 'Make one return crossing back to the origin chain so the round trip is complete.',
  Restaking: 'Restake the deposit into one of the protocol’s listed operators and keep it delegated.',
  'Yield Aggregator': 'Let the vault auto-compound for the full hold and take one manual harvest mid-way.',
  'Risk Curators': 'Allocate to one curated vault and leave the allocation untouched for the full hold.',
  'Onchain Capital Allocator': 'Join one allocation round and keep the capital committed until the round closes.',
  'Basis Trading': 'Keep the basis position open through one funding cycle and record the funding received.',
};

export interface FarmPlan {
  steps: string[];
  capital_usd: number;
  gas_usd: number;
  total_cost_usd: number;
  active_hours: number;
  break_even_fdv_usd: number;
  net_ev_usd: number;
  ev_per_hour_usd: number;
}

export function farmPlan(p: Protocol, asOfMs: number, evUsd: number, odds: number): FarmPlan {
  const primary = p.chains[0] ?? 'Ethereum';
  const gas = GAS_USD[primary] ?? DEFAULT_GAS_USD;
  const capital = capitalTier(p.tvl_usd);
  const age = ageDays(p, asOfMs);
  const hold = holdDays(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const action = CATEGORY_ACTION[p.category ?? ''] ??
    'Use the protocol’s main feature once a week so the wallet shows repeated, genuine use.';
  const asset = p.chains.includes('Ethereum') ? 'ETH' : p.chains.includes('Solana') ? 'SOL' : 'the chain’s native asset';
  const steps = [
    `Bridge $${capital} of stablecoins to ${primary} using a canonical bridge, and keep the bridge receipt.`,
    `Swap the stablecoins into ${asset} on ${primary} so the position starts from a real on-chain trade.`,
    `Deposit the ${asset} into ${p.name}’s main product and keep the deposit receipt and transaction hash.`,
    action,
    `Hold the position for ${hold} days and claim or compound once a week, ${weeks} times in total.`,
    `Save every transaction hash and a screenshot of the position page as proof of genuine use.`,
    `Unwind in reverse: withdraw from ${p.name}, swap back to stablecoins, and bridge out of ${primary}.`,
  ];
  // On-chain transactions: bridge in, swap in, deposit, weekly claims, unwind (withdraw + swap + bridge).
  const nTx = 3 + weeks + 3;
  const gasUsd = Math.round((BRIDGE_FEE_USD + nTx * gas + BRIDGE_FEE_USD) * 100) / 100;
  const totalCost = Math.round((capital + gasUsd) * 100) / 100;
  const activeHours = Math.round((1 + 0.25 * nTx + 0.25 * weeks) * 100) / 100;
  const breakEven = Math.round(totalCost / Math.max(0.05, odds));
  const netEv = Math.round((evUsd - totalCost) * 100) / 100;
  return {
    steps,
    capital_usd: capital,
    gas_usd: gasUsd,
    total_cost_usd: totalCost,
    active_hours: activeHours,
    break_even_fdv_usd: breakEven,
    net_ev_usd: netEv,
    ev_per_hour_usd: Math.round((netEv / activeHours) * 100) / 100,
  };
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  is_watchlist: boolean;
  token_odds: number;
  fitted_fdv_usd: number;
  implied_value_usd: number;
  fitted_ratio: number;
  model_log_ratio: number;
  model_contributions: Record<string, number>;
  farm_steps: string[];
  farm: FarmPlan;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  fdv_tvl_ratio: number;
  age_days: number | null;
}

export interface Board {
  as_of: string;
  model_version: string;
  model: FitResult;
  odds_model: OddsModel;
  meta: {
    protocols_total: number;
    pre_token_total: number;
    rankable_total: number;
    watchlist_total: number;
    watchlist_ranked: number;
    comps_used: number;
    live_total: number;
    live_shown: number;
  };
  rows: BoardRow[];
  live: LiveRow[];
}

export function buildBoard(s: Snapshot): Board {
  const asOfMs = Date.parse(s.as_of + 'T00:00:00Z');
  const fit = fitLaunchModel(s);
  const odds = fitTokenOdds(s);
  const watchlist = new Set(s.watchlist);

  const ranked = s.protocols
    .filter(isRankable)
    .map((p) => {
      const logRatio = predictLogRatio(p, fit, asOfMs);
      const ratio = Math.exp(logRatio);
      const fittedFdv = Math.max(1, Math.round(p.tvl_usd * ratio));
      const o = tokenOdds(p, odds, asOfMs);
      const ev = Math.round(fittedFdv * o);
      const farm = farmPlan(p, asOfMs, ev, o);
      const row: BoardRow = {
        rank: 0,
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        age_days: ageDays(p, asOfMs),
        is_watchlist: watchlist.has(p.slug),
        token_odds: Math.round(o * 1000) / 1000,
        fitted_fdv_usd: fittedFdv,
        implied_value_usd: ev,
        fitted_ratio: Math.round(ratio * 10000) / 10000,
        model_log_ratio: Math.round(logRatio * 1000) / 1000,
        model_contributions: contributions(p, fit, asOfMs),
        farm_steps: farm.steps,
        farm,
      };
      return row;
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  const live = s.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      fdv_tvl_ratio: Math.round((p.mcap_usd as number) / p.tvl_usd * 10000) / 10000,
      age_days: ageDays(p, asOfMs),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 100);

  const preTokenTotal = s.protocols.filter(isPreToken).length;
  return {
    as_of: s.as_of,
    model_version: MODEL_VERSION,
    model: fit,
    odds_model: odds,
    meta: {
      protocols_total: s.protocols.length,
      pre_token_total: preTokenTotal,
      rankable_total: ranked.length,
      watchlist_total: s.watchlist.length,
      watchlist_ranked: ranked.filter((r) => r.is_watchlist).length,
      comps_used: fit.comps_used,
      live_total: s.protocols.filter((p) => !isPreToken(p)).length,
      live_shown: live.length,
    },
    rows: ranked,
    live,
  };
}

/** The board's own gate: the same checks main.ts enforces before writing the dossier. */
export function boardIssue(b: Board, watchlist: string[]): string | null {
  if (b.rows.length < 100) return `board has ${b.rows.length} rows, fewer than 100`;
  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i];
    if (r.rank !== i + 1) return `row ${i} has rank ${r.rank}, expected ${i + 1}`;
    if (i > 0 && r.implied_value_usd > b.rows[i - 1].implied_value_usd) {
      return `row ${r.rank} implied value ${r.implied_value_usd} exceeds row ${r.rank - 1}`;
    }
    if (!Number.isFinite(r.implied_value_usd) || r.implied_value_usd < 0) {
      return `row ${r.rank} has a bad implied value`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `row ${r.rank} has ${r.farm_steps.length} farm steps, expected 3..12`;
    }
    for (const st of r.farm_steps) {
      if (st.length < 20 || st.length > 600) return `row ${r.rank} has a farm step of ${st.length} chars`;
    }
  }
  const slugs = new Set(b.rows.map((r) => r.slug));
  for (const w of watchlist) if (!slugs.has(w)) return `watchlist slug ${w} is missing from the board`;
  return null;
}
