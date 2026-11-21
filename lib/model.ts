// radar-3: fitted token-launch model over the make.fun token-radar-01 snapshot.
// Everything here is a pure function of the snapshot: no clocks, no randomness, no network.
// The fit (v3, chosen because it is the only form that survives every out-of-sample test
// — see METHOD.md): ridge regression of log(market cap / TVL) on log10 TVL alone, λ = 3,
// over one traded comp per ticker. The launch value of a pre-token protocol is its TVL
// times the fitted ratio, and the board ranks by expected value = token odds x fitted FDV.
// A 20-feature ridge is kept only as a benchmark, to show what was tried and dropped.

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
export const MODEL_VERSION = 'radar-4';
export const RIDGE_LAMBDA = 3;
export const FULL_LAMBDA = 10;
export const BOOTSTRAP_RESAMPLES = 200;
export const BOOTSTRAP_SEED = 20261121;
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
  return unrankableReason(p) === null;
}

/** Why a protocol is not ranked. Null means rankable. The checks run in the same
 *  order as the watchlist's exclusion rule, so the first reason that applies wins. */
export function unrankableReason(p: Protocol): string | null {
  if (!isPreToken(p)) return 'live_token';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'excluded_category';
  if (VERSIONED_NAME.test(p.name)) return 'versioned_name';
  if (WRAPPED_NAME.test(p.name)) return 'wrapped_or_staked_name';
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return 'exchange_name';
  return null;
}

/** Traded comps for the fit: a positive market cap and positive TVL, one row per ticker —
 *  the snapshot lists the same token twice (beefy and bifi both record BIFI), so the
 *  smaller-TVL duplicate is dropped and the largest-TVL row is kept. One snapshot row
 *  (autofinance) records a market cap of -1 and is excluded here by the > 0 test. */
export function tradedComps(s: Snapshot): Protocol[] {
  const raw = s.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const bySymbol = new Map<string, Protocol[]>();
  for (const p of raw) {
    const k = (p.symbol ?? '').toLowerCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k)!.push(p);
  }
  const kept = [...bySymbol.values()].map((v) => v.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))[0]);
  const order = new Map(raw.map((p, i) => [p.slug, i]));
  return kept.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
}

/** Slugs dropped by the one-per-ticker dedup, for the record. */
export function dedupDropped(s: Snapshot): string[] {
  const raw = s.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const kept = new Set(tradedComps(s).map((p) => p.slug));
  return raw.filter((p) => !kept.has(p.slug)).map((p) => p.slug);
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

/** The model itself: intercept + log10 TVL only. Everything else was tried and dropped
 *  (see METHOD.md) — no other feature survives leave-one-out and the walk-forward splits. */
export function sizeFeatures(p: Protocol): number[] {
  return [1, Math.log10(Math.max(1, p.tvl_usd))];
}

export const SIZE_FEATURE_NAMES = ['intercept', 'log10_tvl'];

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

export interface ValidationStats {
  r2: number;
  median_abs_log_error: number;
  mean_abs_log_error: number;
}

export interface TimeSplit {
  label: string;
  cutoff: string;
  n_train: number;
  n_test: number;
  r2: number;
  median_abs_log_error: number;
}

export interface FitResult {
  version: string;
  lambda: number;
  comps_used: number;
  comps_total: number;
  comps_dedup_dropped: string[];
  target_winsor: [number, number];
  coefficients: Record<string, number>;
  feature_names: string[];
  /** Leave-one-out validation over the comps. */
  loo: ValidationStats;
  /** Deterministic 80/20 split: slug hash % 5 === 0 is the test set. */
  held_out: { n_test: number; r2: number; median_abs_log_error: number };
  /** Walk-forward: fit on protocols listed before the cutoff, test on newer ones. */
  time_splits: TimeSplit[];
  /** The 20-feature ridge (age, growth, chains, categories) on the same comps, kept as
   *  the benchmark that the size-only model had to beat — and did, out of sample. */
  benchmark_full: {
    lambda: number;
    loo: ValidationStats;
    held_out: { n_test: number; r2: number; median_abs_log_error: number };
    time_splits: TimeSplit[];
  };
  /** Bootstrap rank stability: 200 deterministic refits on resampled comps. */
  bootstrap: { resamples: number; seed: number; median_band_width: number; max_band_width: number };
  /** Per-ranked-protocol bootstrap rank band (p10/p50/p90 of expected-value rank). */
  bootstrap_bands: Record<string, BootstrapBand>;
  /** Per-ranked-protocol bootstrap fitted-value band (p10/p50/p90 of fitted FDV over the
   *  same 200 refits). Parameter uncertainty only — the residual-based prediction
   *  interval below is the honest statement of how far a real launch value can sit. */
  bootstrap_value_bands: Record<string, BootstrapBand>;
  /** The p10–p90 prediction interval for a fitted log ratio: predicted ± the 80th
   *  percentile of |leave-one-out residual|. LOO coverage is ~80% by construction; the
   *  held-out coverage is the clean check (width refit on the training comps only). */
  interval: {
    half_width_log: number;
    factor: number;
    loo_coverage: number;
    loo_n: number;
    held_out: { n_test: number; coverage: number; half_width_log: number; factor: number };
  };
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

/** Quantile by the same index rule the bootstrap uses (floor(f * (n - 1))). */
function quantileOf(v: number[], f: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))];
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

/** Deterministic PRNG for the bootstrap (LCG, fixed seed): no Math.random anywhere. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Walk-forward split: fit on comps listed before `cutoff`, test on comps listed on or
 *  after it. Comps with an unknown listing date take part in neither side. */
function timeSplitStats(
  comps: Protocol[],
  cutoff: string,
  fitFn: (train: Protocol[], trainY: number[]) => (p: Protocol) => number,
): TimeSplit {
  const cut = Date.parse(cutoff + 'T00:00:00Z');
  const train = comps.filter((p) => p.listed_at && Date.parse(p.listed_at + 'T00:00:00Z') < cut);
  const test = comps.filter((p) => p.listed_at && Date.parse(p.listed_at + 'T00:00:00Z') >= cut);
  const predict = fitFn(train, train.map(targetOf));
  const errs = test.map((p) => targetOf(p) - predict(p));
  const meanTest = test.reduce((a, p) => a + targetOf(p), 0) / test.length;
  const ssTot = test.reduce((a, p) => a + (targetOf(p) - meanTest) ** 2, 0);
  return {
    label: `fit listed before ${cutoff.slice(0, 4)}, test ${cutoff.slice(0, 4)} and later`,
    cutoff,
    n_train: train.length,
    n_test: test.length,
    r2: 1 - errs.reduce((a, e) => a + e * e, 0) / ssTot,
    median_abs_log_error: medianOf(errs.map(Math.abs)),
  };
}

function heldOutStats(
  comps: Protocol[],
  fitFn: (train: Protocol[], trainY: number[]) => (p: Protocol) => number,
): { n_test: number; r2: number; median_abs_log_error: number } {
  const test = comps.filter((p) => slugHash(p.slug) % 5 === 0);
  const train = comps.filter((p) => slugHash(p.slug) % 5 !== 0);
  const predict = fitFn(train, train.map(targetOf));
  const errs = test.map((p) => targetOf(p) - predict(p));
  const meanTest = test.reduce((a, p) => a + targetOf(p), 0) / test.length;
  const ssTot = test.reduce((a, p) => a + (targetOf(p) - meanTest) ** 2, 0);
  return {
    n_test: test.length,
    r2: 1 - errs.reduce((a, e) => a + e * e, 0) / ssTot,
    median_abs_log_error: medianOf(errs.map(Math.abs)),
  };
}

/** Leave-one-out predictions for every comp (each prediction is out of sample for its
 *  own point). Shared by the interval computation; looStats keeps its own loop. */
function looPredictions(
  comps: Protocol[],
  y: number[],
  fitFn: (train: Protocol[], trainY: number[]) => (p: Protocol) => number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const trainY = y.filter((_, j) => j !== i);
    out.push(fitFn(train, trainY)(comps[i]));
  }
  return out;
}

/** The p10–p90 prediction interval for the fitted log ratio: predicted ± the 80th
 *  percentile of |leave-one-out residual|. Returns the width, the LOO coverage at that
 *  width, and the clean held-out check, where the width is refit on the training comps
 *  only and coverage is measured on the held-out 20%. */
function valueInterval(
  comps: Protocol[],
  y: number[],
  fitFn: (train: Protocol[], trainY: number[]) => (p: Protocol) => number,
): FitResult['interval'] {
  const looPred = looPredictions(comps, y, fitFn);
  const looAbs = y.map((v, i) => Math.abs(v - looPred[i]));
  const halfWidth = quantileOf(looAbs, 0.8);
  const looCoverage = looAbs.filter((e) => e <= halfWidth).length / looAbs.length;
  const test = comps.filter((p) => slugHash(p.slug) % 5 === 0);
  const train = comps.filter((p) => slugHash(p.slug) % 5 !== 0);
  const trainY = train.map(targetOf);
  const trainLooPred = looPredictions(train, trainY, fitFn);
  const trainLooAbs = trainY.map((v, i) => Math.abs(v - trainLooPred[i]));
  const hoHalfWidth = quantileOf(trainLooAbs, 0.8);
  const predictHO = fitFn(train, trainY);
  const hoCovered = test.filter((p) => Math.abs(targetOf(p) - predictHO(p)) <= hoHalfWidth).length;
  return {
    half_width_log: Math.round(halfWidth * 1000) / 1000,
    factor: Math.round(Math.exp(halfWidth) * 100) / 100,
    loo_coverage: Math.round(looCoverage * 1000) / 1000,
    loo_n: comps.length,
    held_out: {
      n_test: test.length,
      coverage: Math.round((hoCovered / test.length) * 1000) / 1000,
      half_width_log: Math.round(hoHalfWidth * 1000) / 1000,
      factor: Math.round(Math.exp(hoHalfWidth) * 100) / 100,
    },
  };
}

export interface BootstrapBand {
  p10: number;
  p50: number;
  p90: number;
}

/** Refit the size-only model on bootstrap resamples of the comps and record, for every
 *  ranked protocol, the distribution of its expected-value rank and of its fitted FDV.
 *  Deterministic: fixed seed, fixed resample count, ties break by slug exactly as the
 *  board does. */
function bootstrapBands(
  comps: Protocol[],
  ranked: Protocol[],
  odds: OddsModel,
  asOfMs: number,
): {
  bands: Record<string, BootstrapBand>;
  value_bands: Record<string, BootstrapBand>;
  median_band_width: number;
  max_band_width: number;
} {
  const rnd = lcg(BOOTSTRAP_SEED);
  const fitOn = (sample: Protocol[]) =>
    ridgeFit(sample.map(sizeFeatures), sample.map(targetOf), RIDGE_LAMBDA);
  const predictWith = (b: number[]) => (p: Protocol) =>
    clamp(sizeFeatures(p).reduce((a, v, j) => a + v * b[j], 0), TARGET_LO, TARGET_HI);
  const ranks: number[][] = ranked.map(() => []);
  const fdvs: number[][] = ranked.map(() => []);
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rnd() * comps.length)]);
    const predict = predictWith(fitOn(sample));
    const evs = ranked.map((p, i) => {
      const fdv = Math.max(1, Math.round(p.tvl_usd * Math.exp(predict(p))));
      fdvs[i].push(fdv);
      return fdv * tokenOdds(p, odds, asOfMs);
    });
    const order = evs
      .map((ev, i) => [ev, i] as const)
      .sort((a, b) => b[0] - a[0] || (ranked[a[1]].slug < ranked[b[1]].slug ? -1 : 1));
    order.forEach(([, i], pos) => ranks[i].push(pos + 1));
  }
  const q = (sorted: number[], f: number) => sorted[Math.floor(f * (sorted.length - 1))];
  const bands: Record<string, BootstrapBand> = {};
  const value_bands: Record<string, BootstrapBand> = {};
  const widths: number[] = [];
  ranked.forEach((p, i) => {
    const rs = [...ranks[i]].sort((a, b) => a - b);
    bands[p.slug] = { p10: q(rs, 0.1), p50: q(rs, 0.5), p90: q(rs, 0.9) };
    widths.push(bands[p.slug].p90 - bands[p.slug].p10);
    const vs = [...fdvs[i]].sort((a, b) => a - b);
    value_bands[p.slug] = { p10: q(vs, 0.1), p50: q(vs, 0.5), p90: q(vs, 0.9) };
  });
  return { bands, value_bands, median_band_width: medianOf(widths), max_band_width: Math.max(...widths) };
}

const TIME_SPLIT_CUTOFFS = ['2023-01-01', '2024-01-01', '2025-01-01'];

export function fitLaunchModel(s: Snapshot): FitResult {
  const asOfMs = Date.parse(s.as_of + 'T00:00:00Z');
  const comps = tradedComps(s);
  const y = comps.map(targetOf);

  const sizeFit = (train: Protocol[], trainY: number[]) => {
    const b = ridgeFit(train.map(sizeFeatures), trainY, RIDGE_LAMBDA);
    return (p: Protocol) =>
      clamp(sizeFeatures(p).reduce((a, v, j) => a + v * b[j], 0), TARGET_LO, TARGET_HI);
  };
  const fullFit = (train: Protocol[], trainY: number[]) => {
    const b = ridgeFit(train.map((p) => features(p, asOfMs)), trainY, FULL_LAMBDA);
    return (p: Protocol) =>
      clamp(features(p, asOfMs).reduce((a, v, j) => a + v * b[j], 0), TARGET_LO, TARGET_HI);
  };

  const beta = ridgeFit(comps.map(sizeFeatures), y, RIDGE_LAMBDA);
  const coefficients: Record<string, number> = {};
  SIZE_FEATURE_NAMES.forEach((n, i) => {
    coefficients[n] = beta[i];
  });

  const loo = looStats(comps, y, asOfMs, sizeFit);
  const heldOut = heldOutStats(comps, sizeFit);
  const timeSplits = TIME_SPLIT_CUTOFFS.map((c) => timeSplitStats(comps, c, sizeFit));
  const looFull = looStats(comps, y, asOfMs, fullFit);
  const heldOutFull = heldOutStats(comps, fullFit);
  const timeSplitsFull = TIME_SPLIT_CUTOFFS.map((c) => timeSplitStats(comps, c, fullFit));

  const odds = fitTokenOdds(s);
  const ranked = s.protocols.filter(isRankable);
  const boot = bootstrapBands(comps, ranked, odds, asOfMs);
  const interval = valueInterval(comps, y, sizeFit);

  return {
    version: MODEL_VERSION,
    lambda: RIDGE_LAMBDA,
    comps_used: comps.length,
    comps_total: s.protocols.filter((p) => p.mcap_usd !== null).length,
    comps_dedup_dropped: dedupDropped(s),
    target_winsor: [TARGET_LO, TARGET_HI],
    coefficients,
    feature_names: [...SIZE_FEATURE_NAMES],
    loo,
    held_out: heldOut,
    time_splits: timeSplits,
    benchmark_full: {
      lambda: FULL_LAMBDA,
      loo: looFull,
      held_out: heldOutFull,
      time_splits: timeSplitsFull,
    },
    bootstrap: {
      resamples: BOOTSTRAP_RESAMPLES,
      seed: BOOTSTRAP_SEED,
      median_band_width: boot.median_band_width,
      max_band_width: boot.max_band_width,
    },
    bootstrap_bands: boot.bands,
    bootstrap_value_bands: boot.value_bands,
    interval,
    median_log_ratio: medianOf(y),
    median_ratio: Math.exp(medianOf(y)),
  };
}

export function predictLogRatio(p: Protocol, fit: FitResult, asOfMs: number): number {
  const x = sizeFeatures(p);
  return clamp(
    x.reduce((a, v, j) => a + v * fit.coefficients[fit.feature_names[j]], 0),
    TARGET_LO,
    TARGET_HI,
  );
}

export function contributions(p: Protocol, fit: FitResult, asOfMs: number): Record<string, number> {
  const x = sizeFeatures(p);
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
  /** Held-out validation of the odds themselves: the model is refit on the 80% of
   *  protocols whose slug hash is not 0 mod 5 and scored on the other 20%. Brier and
   *  log-loss are shown against the global-rate baseline, and the calibration table
   *  shows the mean predicted odds against the actual token rate per age band. */
  held_out: {
    n_test: number;
    brier: number;
    brier_global: number;
    log_loss: number;
    log_loss_global: number;
    calibration: { band: string; n: number; pred: number; actual: number }[];
  };
}

const AGE_BANDS: [number, number][] = [
  [0, 180],
  [180, 365],
  [365, 730],
  [730, 100000],
];

export function fitTokenOdds(s: Snapshot): OddsModel {
  const asOfMs = Date.parse(s.as_of + 'T00:00:00Z');
  const model = fitTokenOddsOn(s.protocols, asOfMs);
  // Held-out validation: refit on the 80% whose slug hash is not 0 mod 5 (the same
  // split the launch-value held-out test uses) and score the other 20%.
  const test = s.protocols.filter((p) => slugHash(p.slug) % 5 === 0);
  const train = s.protocols.filter((p) => slugHash(p.slug) % 5 !== 0);
  const trainOdds = fitTokenOddsOn(train, asOfMs);
  const globalTrain = train.filter((p) => !isPreToken(p)).length / train.length;
  let brier = 0;
  let brierGlobal = 0;
  let logLoss = 0;
  let logLossGlobal = 0;
  for (const p of test) {
    const yv = isPreToken(p) ? 0 : 1;
    const pr = clamp(tokenOdds(p, trainOdds, asOfMs), 1e-9, 1 - 1e-9);
    const pg = clamp(globalTrain, 1e-9, 1 - 1e-9);
    brier += (pr - yv) ** 2;
    brierGlobal += (pg - yv) ** 2;
    logLoss += -(yv * Math.log(pr) + (1 - yv) * Math.log(1 - pr));
    logLossGlobal += -(yv * Math.log(pg) + (1 - yv) * Math.log(1 - pg));
  }
  const n = test.length;
  const calibration: OddsModel['held_out']['calibration'] = [];
  const bandGroups: { label: string; grp: Protocol[] }[] = AGE_BANDS.map(([lo, hi]) => ({
    label: hi >= 100000 ? `${lo}d+` : `${lo}–${hi}d`,
    grp: test.filter((p) => {
      const a = ageDays(p, asOfMs);
      return a !== null && a >= lo && a < hi;
    }),
  }));
  bandGroups.push({ label: 'age unknown', grp: test.filter((p) => ageDays(p, asOfMs) === null) });
  for (const { label, grp } of bandGroups) {
    if (!grp.length) continue;
    calibration.push({
      band: label,
      n: grp.length,
      pred: Math.round((grp.reduce((a, p) => a + tokenOdds(p, trainOdds, asOfMs), 0) / grp.length) * 1000) / 1000,
      actual: Math.round((grp.filter((p) => !isPreToken(p)).length / grp.length) * 1000) / 1000,
    });
  }
  return {
    ...model,
    held_out: {
      n_test: n,
      brier: Math.round((brier / n) * 10000) / 10000,
      brier_global: Math.round((brierGlobal / n) * 10000) / 10000,
      log_loss: Math.round((logLoss / n) * 10000) / 10000,
      log_loss_global: Math.round((logLossGlobal / n) * 10000) / 10000,
      calibration,
    },
  };
}

function fitTokenOddsOn(protocols: Protocol[], asOfMs: number): Omit<OddsModel, 'held_out'> {
  const global = protocols.filter((p) => !isPreToken(p)).length / protocols.length;
  const prior = 20;
  const age_bands = AGE_BANDS.map(([lo, hi]) => {
    const grp = protocols.filter((p) => {
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
  const cats = [...new Set(protocols.map((p) => p.category ?? 'Unknown'))];
  for (const c of cats) {
    const grp = protocols.filter((p) => (p.category ?? 'Unknown') === c);
    const tok = grp.filter((p) => !isPreToken(p)).length;
    const rate = grp.length ? tok / grp.length : global;
    category_rates[c] = {
      n: grp.length,
      rate,
      shrunk: (grp.length * rate + prior * global) / (grp.length + prior),
    };
  }
  return { global_rate: global, n_protocols: protocols.length, age_bands, category_rates, shrink_prior: prior };
}

export function tokenOdds(p: Protocol, odds: Omit<OddsModel, 'held_out'>, asOfMs: number): number {
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
  /** Dated plan: the farm starts on the snapshot date, claims weekly, and unwinds on
   *  the end date. Pure date arithmetic on the snapshot date — no clock. */
  start_date: string;
  end_date: string;
  claim_dates: string[];
  hold_days: number;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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
  const claimDates: string[] = [];
  for (let d = 7; d < hold; d += 7) claimDates.push(isoDate(asOfMs + d * DAY_MS));
  return {
    steps,
    capital_usd: capital,
    gas_usd: gasUsd,
    total_cost_usd: totalCost,
    active_hours: activeHours,
    break_even_fdv_usd: breakEven,
    net_ev_usd: netEv,
    ev_per_hour_usd: Math.round((netEv / activeHours) * 100) / 100,
    start_date: isoDate(asOfMs),
    end_date: isoDate(asOfMs + hold * DAY_MS),
    claim_dates: claimDates,
    hold_days: hold,
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
  /** Bootstrap rank band: p10/p50/p90 of this row's expected-value rank over 200 refits. */
  bootstrap_rank_p10: number;
  bootstrap_rank_p50: number;
  bootstrap_rank_p90: number;
  /** Bootstrap fitted-value band: p10/p90 of fitted FDV over the same 200 refits
   *  (parameter uncertainty only — see the prediction interval for the honest range). */
  fitted_fdv_p10: number;
  fitted_fdv_p90: number;
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

export interface UnrankedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  /** live_token | excluded_category | versioned_name | wrapped_or_staked_name | exchange_name */
  reason: string;
}

export interface BuildCheck {
  label: string;
  detail: string;
  passed: boolean;
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
    /** Every protocol in the snapshot, by fate: ranked + one count per unranked reason. */
    census: Record<string, number>;
    /** Smallest ratio, over all 198 rows, of (prediction-interval low-end EV) to farm
     *  cost: every row clears its farm cost by at least this much even at the low end
     *  of its value interval, so the farm verdict is FARM on every row. */
    min_pred_interval_margin: number;
  };
  rows: BoardRow[];
  /** Every protocol not ranked, with the reason it is not ranked. Ranked + unranked = 758. */
  unranked: UnrankedRow[];
  live: LiveRow[];
  /** Build-time checks: every check the build ran, with its result. The build fails
   *  (exit 1) if any check fails — the checks are the entry's own proofs, shown on the
   *  board tab as the integrity strip. */
  checks: BuildCheck[];
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
        bootstrap_rank_p10: 0,
        bootstrap_rank_p50: 0,
        bootstrap_rank_p90: 0,
        fitted_fdv_p10: 0,
        fitted_fdv_p90: 0,
        farm_steps: farm.steps,
        farm,
      };
      return row;
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
    const band = fit.bootstrap_bands[r.slug];
    r.bootstrap_rank_p10 = band.p10;
    r.bootstrap_rank_p50 = band.p50;
    r.bootstrap_rank_p90 = band.p90;
    const vb = fit.bootstrap_value_bands[r.slug];
    r.fitted_fdv_p10 = vb.p10;
    r.fitted_fdv_p90 = vb.p90;
  });

  // Smallest margin, over all rows, of the prediction-interval low-end EV to the farm
  // cost: low-end EV = fitted FDV ÷ interval factor × token odds.
  let minMargin = Infinity;
  for (const r of ranked) {
    const lowEv = (r.fitted_fdv_usd / fit.interval.factor) * r.token_odds;
    minMargin = Math.min(minMargin, lowEv / r.farm.total_cost_usd);
  }
  minMargin = Math.round(minMargin * 10) / 10;

  const rankedSlugs = new Set(ranked.map((r) => r.slug));
  const unranked: UnrankedRow[] = s.protocols
    .filter((p) => !rankedSlugs.has(p.slug))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      reason: unrankableReason(p) as string,
    }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const census: Record<string, number> = { ranked: ranked.length };
  for (const u of unranked) census[u.reason] = (census[u.reason] ?? 0) + 1;

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
  const positiveMcap = s.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const zeroOrNegMcap = fit.comps_total - positiveMcap;
  const checks: BuildCheck[] = [
    {
      label: 'Census',
      detail: `${ranked.length} ranked + ${unranked.length} unranked = ${s.protocols.length} protocols`,
      passed: ranked.length + unranked.length === s.protocols.length,
    },
    {
      label: 'Watchlist',
      detail: `${ranked.filter((r) => r.is_watchlist).length} of ${s.watchlist.length} watchlist protocols ranked`,
      passed: ranked.filter((r) => r.is_watchlist).length === s.watchlist.length,
    },
    {
      label: 'Comps',
      detail: `${fit.comps_used} comps from ${fit.comps_total} token rows: ${zeroOrNegMcap} with zero or negative market cap excluded, ${fit.comps_dedup_dropped.length} duplicate ticker (${fit.comps_dedup_dropped.join(', ') || 'none'}) dropped`,
      passed: fit.comps_used === positiveMcap - fit.comps_dedup_dropped.length,
    },
    {
      label: 'Value model, leave-one-out',
      detail: `LOO R² ${fit.loo.r2.toFixed(3)} > 0, median error ×${Math.exp(fit.loo.median_abs_log_error).toFixed(1)}`,
      passed: fit.loo.r2 > 0,
    },
    {
      label: 'Token odds, held out',
      detail: `Brier ${odds.held_out.brier.toFixed(4)} vs ${odds.held_out.brier_global.toFixed(4)} for the global rate (n=${odds.held_out.n_test})`,
      passed: odds.held_out.brier < odds.held_out.brier_global,
    },
    {
      label: 'Value interval, held out',
      detail: `p10–p90 interval covers ${Math.round(fit.interval.held_out.coverage * fit.interval.held_out.n_test)} of ${fit.interval.held_out.n_test} held-out tokens (${(fit.interval.held_out.coverage * 100).toFixed(1)}%)`,
      passed: fit.interval.held_out.coverage >= 0.6 && fit.interval.held_out.coverage <= 1,
    },
    {
      label: 'Farm verdict',
      detail: `every row's prediction-interval low-end EV clears its farm cost by at least ${minMargin.toLocaleString('en-US')}× — FARM on all ${ranked.length} rows`,
      passed: minMargin > 1,
    },
  ];
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
      census,
      min_pred_interval_margin: minMargin,
    },
    rows: ranked,
    unranked,
    live,
    checks,
  };
}

/** The board's own gate: the same checks main.ts enforces before writing the dossier. */
export function boardIssue(b: Board, watchlist: string[]): string | null {
  if (b.rows.length < 100) return `board has ${b.rows.length} rows, fewer than 100`;
  if (b.rows.length + b.unranked.length !== b.meta.protocols_total) {
    return `census mismatch: ${b.rows.length} ranked + ${b.unranked.length} unranked != ${b.meta.protocols_total} protocols`;
  }
  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i];
    if (r.rank !== i + 1) return `row ${i} has rank ${r.rank}, expected ${i + 1}`;
    if (i > 0 && r.implied_value_usd > b.rows[i - 1].implied_value_usd) {
      return `row ${r.rank} implied value ${r.implied_value_usd} exceeds row ${r.rank - 1}`;
    }
    if (!Number.isFinite(r.implied_value_usd) || r.implied_value_usd < 0) {
      return `row ${r.rank} has a bad implied value`;
    }
    if (
      r.bootstrap_rank_p10 < 1 ||
      r.bootstrap_rank_p90 > b.rows.length ||
      r.bootstrap_rank_p10 > r.bootstrap_rank_p50 ||
      r.bootstrap_rank_p50 > r.bootstrap_rank_p90
    ) {
      return `row ${r.rank} has a bad bootstrap rank band ${r.bootstrap_rank_p10}-${r.bootstrap_rank_p50}-${r.bootstrap_rank_p90}`;
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
  for (const c of b.checks) if (!c.passed) return `build check failed: ${c.label} — ${c.detail}`;
  return null;
}
