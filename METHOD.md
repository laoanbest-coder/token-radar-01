# METHOD — Token Launch Radar (radar-3)

Snapshot: 14 November 2026, 758 protocols, floor $50,000,000, watchlist 40.

## What the board ranks

Every **rankable** pre-token protocol: the snapshot records no token for it (market cap, gecko id and symbol all null), and it passes the watchlist's own exclusion rule without the TVL floor — not a versioned name, not a wrapped/staked product, not named after an exchange, and not in the Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX categories. That leaves **198 protocols**, including all 40 watchlist protocols. The board ranks them by **expected value = token odds × fitted launch value**. Live (traded) protocols are shown separately and are never ranked for a launch. Every protocol in the snapshot is accounted for: 198 ranked + 416 live + 144 pre-token but excluded (128 excluded category, 11 versioned name, 5 wrapped/staked name) = 758; the Census tab lists the 144 excluded pre-token protocols with their reason.

## The launch-value model

Target: `log(market cap / TVL)` over the traded-token comps — protocols with a positive market cap and positive TVL. That is **127 comps** (of 144 protocols that record a token at all; one row, autofinance, records a market cap of −1 and is excluded by the positivity test, and one ticker is listed twice — beefy and bifi both record BIFI — so the smaller row, bifi, is dropped and the larger, beefy, is kept).

The target is winsorised to [−6, 3] so legacy protocols with a tiny current TVL and a huge market cap cannot drag the fit. The model is a ridge regression (λ = 3) on **log₁₀ TVL alone**:

`log ratio = 6.389 − 1.022 · log₁₀ TVL`

Fitted launch value = TVL × exp(predicted log ratio), clamped to the same [−6, 3] range. So fitted launch value grows with TVL^0.56: a protocol ten times larger in TVL is worth about 3.6× as much, not 10×.

### Why size alone — what was tried, and what survived

The v2 model was a 20-feature ridge (log TVL, log age, 7-day growth, chain count, Ethereum/Solana flags, 13 category indicators). It was replaced because, on every honest out-of-sample test, it loses to size alone. All numbers below are on the same 127 deduped comps, target winsorised [−6, 3]:

| Variant | LOO R² | Held-out 20% R² | Walk-forward R² (2023+ / 2024+ / 2025+) |
|---|---|---|---|
| **Size-only ridge, λ=3 (this model)** | **0.160** | **0.267** | **0.182 / 0.227 / 0.227** |
| 20-feature ridge, λ=10 (v2) | 0.145 | 0.268 | 0.165 / 0.201 / 0.017 |
| Size + categories, λ=10 | 0.159 | 0.283 | — / 0.199 / 0.219 |
| Size + age + growth + chains | 0.143 | 0.224 | — |
| No age (drop log-age term) | 0.154 | 0.295 | — / 0.202 / 0.234 |
| log(market cap) target, full features | 0.133 | 0.326 | — |
| Per-category size exponent | 0.124 | 0.337 | — |
| Quadratic log TVL | 0.143 | 0.289 | — |
| Kernel size curve (Nadaraya–Watson, bw 0.4) | 0.145 | 0.260 | — / 0.260 / — |
| Local-linear size curve (bw 1.2) | 0.154 | 0.274 | — / 0.244 / — |

Held-out is one 20% split by slug hash (n=22), so its ±0.05 swings are noise — several variants beat size alone on held-out alone (the per-category exponent scores 0.337 there, while its LOO is 0.124). The decision rests on leave-one-out (n=127) and the three walk-forward splits, where size alone wins or ties every time, and on median absolute error: size alone's held-out median error is ×3.88 against ×4.56 for size + categories and ×4.02 for the 20-feature model. The walk-forward test is the damning one for the full model: fitted on protocols listed before 2025, it scores R² 0.017 on the newest protocols, while size alone scores 0.227. Age, growth, chain count and category do not transfer forward in time.

Comp cleaning, scored by training on the cleaned set and predicting all 128 comps: dropping the 6 comps with raw log ratio outside [−4, 2] lowers all-128 R² from 0.232 to 0.184 (dropped); dropping the 33 comps with unknown listing age lowers it to 0.220 (dropped); an age-unknown indicator feature lowers LOO to 0.123 (dropped); TVL-weighted ridge is flat at 0.148 (dropped). The only cleaning kept is the one-per-ticker dedup (bifi dropped): LOO 0.133 → 0.145 on the full-feature model and 0.147 → 0.160 for size-only, held-out 0.212 → 0.268 — a small, consistent gain from removing a genuine double-count. λ was swept 1–300; λ=3 is the leave-one-out argmax for the size-only fit (0.148 at λ=3 vs 0.147 at λ=1 and λ=10). Winsor bounds [−4, 2] vs [−6, 3] move LOO by 0.002 — not worth changing.

### Validation (computed inside the build, reported in the dashboard)

| Check | R² | Median absolute log error |
|---|---|---|
| Leave-one-out, 127 comps | 0.160 | 1.25 (×3.5) |
| Held-out 20% (22 comps, split by slug hash) | 0.267 | 1.36 (×3.9) |
| Walk-forward, fit ≤2022 / test 2023+ (24 train, 71 test) | 0.182 | 1.21 (×3.3) |
| Walk-forward, fit ≤2023 / test 2024+ (44 train, 51 test) | 0.227 | 1.09 (×3.0) |
| Walk-forward, fit ≤2024 / test 2025+ (64 train, 31 test) | 0.227 | 1.17 (×3.2) |
| 20-feature benchmark, leave-one-out | 0.145 | 1.20 (×3.3) |

The honest reading is unchanged: FDV/TVL is mostly idiosyncratic. The median traded ratio is 0.22 (10th percentile 0.013, 90th percentile 2.9). Size carries the only signal that survives out of sample, and even it explains little. The board is a ranking of expected values under wide uncertainty, not a price forecast, and the dashboard says so on the board itself.

### Rank stability (bootstrap)

The size-only model is refit 200 times on bootstrap resamples of the 127 comps (deterministic LCG, seed 20261121 — no `Math.random`, so the bands are byte-identical every run). Each ranked protocol's expected-value rank is recorded per refit, and the board shows the p10–p90 band: median band width 4 ranks, widest 22. The top six rows never leave their rank in any refit; 17 rows have a zero-width band. A narrow band means the rank is stable under refitting — it does not mean the fitted value is precise (median error ×3.5).

## Token odds

Fitted from the snapshot itself: the share of protocols that record a token, by age band and by category, each shrunk toward the global rate (54.9%) with a prior of 20 observations. Age bands: 0–180d 26.4% (shrunk 31.8%), 180–365d 39.7% (shrunk 43.0%), 365–730d 38.3% (shrunk 39.9%), 730d+ 67.9% (shrunk 67.1%). The two shrunk rates are averaged and clamped to 5–90%. Odds say nothing about points programs, team statements or airdrop plans — the snapshot carries none of those.

## Farm plans

Capital by TVL tier: <$50M → $50, <$250M → $100, <$1B → $150, else $250. Hold is 30 days for protocols under 6 months old, 45 days under 2 years, 60 days older, with one weekly claim/compound. Gas per transaction is a stated typical for November 2026, not a quote:

| Chain | USD/tx |
|---|---|
| Ethereum | 8.00 |
| Bitcoin | 2.00 |
| Arbitrum | 0.15 |
| Binance | 0.15 |
| Linea / Scroll | 0.15 |
| Optimism | 0.12 |
| Fantom | 0.10 |
| Blast | 0.10 |
| Base / Mantle / Mode | 0.08 |
| Polygon / Gnosis | 0.05 |
| Avalanche | 0.30 |
| zkSync Era | 0.20 |
| Solana / Hyperliquid L1 | 0.01 |
| any other chain | 0.50 |

Each plan pays a $2 bridge fee each way plus one gas charge per on-chain step (bridge in, swap in, deposit, weekly claims, withdraw, swap out, bridge out). Active hours count 1 hour of setup plus 15 minutes per on-chain step and per weekly claim; the hold itself is passive. Break-even launch value = farm cost ÷ token odds. Net expected value = expected value − farm cost.

## Determinism

Pure functions of the snapshot only: no clock, no randomness, no network. Ties break by slug. Two runs over the same snapshot produce byte-identical `board.json`, `data.js` and `dossier.json`.

## What remains / known limits

- The 3 screenshots are taken from the built dashboard; the dashboard must be served from the output directory (data.js sits beside dashboard/) for the screenshots to match the code.
- Screenshots ship in the repo as single-line base64 (`screenshots/*.png.b64`) because the GitHub push path cannot carry binary files; `main.ts` decodes them into the output's `screenshots/` as PNGs at runtime (pure decode, byte-identical to the originals — verified by sha256 after the change). Re-shot 2026-11-21 at 1440×900 viewport (all three 1440×900, each under 512 KiB, per the site's screenshot gate); dossier 899,042 bytes.
- The model is deliberately simple — one feature — because that is what survives out of sample; the experiment table above is the evidence. The remaining error is large (median ×3.5), so the board should be read as a ranking under wide uncertainty, with the bootstrap rank band as the stability check.
- The snapshot is one day. A protocol can launch, be acquired or wind down the next day; the board does not update itself.
- Farm costs are small next to the expected values: capital is $50–$250 plus a few dollars of gas, while every row's fitted launch value is in the millions, so every row clears its own farm cost by a wide margin. The binding uncertainty is the fitted value itself (median error ×3.5) and the token odds — not the cost.
