# METHOD — Token Launch Radar (radar-2)

Snapshot: 14 November 2026, 758 protocols, floor $50,000,000, watchlist 40.

## What the board ranks

Every **rankable** pre-token protocol: the snapshot records no token for it (market cap, gecko id and symbol all null), and it passes the watchlist's own exclusion rule without the TVL floor — not a versioned name, not a wrapped/staked product, not named after an exchange, and not in the Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX categories. That leaves **198 protocols**, including all 40 watchlist protocols. The board ranks them by **expected value = token odds × fitted launch value**. Live (traded) protocols are shown separately and are never ranked for a launch.

## The launch-value model

Target: `log(market cap / TVL)` over the traded-token comps — protocols with a positive market cap and positive TVL. That is **128 comps** (of 416 protocols that record a token at all). One snapshot row (autofinance) records a market cap of −1 and is excluded by the positivity test.

The target is winsorised to [−6, 3] so legacy protocols with a tiny current TVL and a huge market cap cannot drag the fit. The model is a ridge regression (λ = 10) with features: intercept, log₁₀ TVL, log1p age in days (unknown age = 365 days), 7-day growth clamped to [−60, 120] and divided by 100, chain count, Ethereum and Solana flags, and 13 category indicators.

Fitted launch value = TVL × exp(predicted log ratio), clamped to the same [−6, 3] range.

### Validation (computed inside the build, reported in the dashboard)

| Check | R² | Median absolute log error |
|---|---|---|
| Leave-one-out, 128 comps | 0.13 | 1.25 (×3.5) |
| Held-out 20% (23 comps, split by slug hash) | 0.21 | 1.39 (×4.0) |
| Size-only benchmark, leave-one-out | 0.15 | 1.24 (×3.5) |

The honest reading: FDV/TVL is mostly idiosyncratic. The median traded ratio is 0.22 (10th percentile 0.013, 90th percentile 2.9). Size carries most of the signal — the coefficient on log₁₀ TVL is about −1.0, so market cap grows roughly with TVL^0.56 — and growth, age and category add almost nothing out of sample over size alone. The board is a ranking of expected values under wide uncertainty, not a price forecast, and the dashboard says so on the board itself.

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
- Screenshots ship in the repo as single-line base64 (`screenshots/*.png.b64`) because the GitHub push path cannot carry binary files; `main.ts` decodes them into the output's `screenshots/` as PNGs at runtime (pure decode, byte-identical to the originals — verified by sha256 after the change). Re-shot 2026-11-21 at 1440×900 viewport (all three 1440×900, each under 512 KiB, per the site's screenshot gate); dossier 893,712 bytes.
- The model is deliberately simple: with 128 comps and a target this noisy, a heavier model (interactions, more categories) overfits — the leave-one-out numbers above are the evidence.
- The snapshot is one day. A protocol can launch, be acquired or wind down the next day; the board does not update itself.
- Farm costs are small next to the expected values: capital is $50–$250 plus a few dollars of gas, while every row's fitted launch value is in the millions, so every row clears its own farm cost by a wide margin. The binding uncertainty is the fitted value itself (median error ×3.5) and the token odds — not the cost.
