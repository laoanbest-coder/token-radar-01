# Token Launch Radar

A token launch radar built for make.fun's [Build the best token launch radar](https://make.fun/bounty/token-radar-01) bounty.

It ranks every rankable pre-token protocol in the 14 November 2026 snapshot by **expected value** — token odds × fitted launch value — and gives each one a costed farm plan. The launch value is fitted, not assumed: a ridge regression of log(market cap / TVL) over the traded-token protocols in the same snapshot, validated leave-one-out and on a held-out 20%.

## Run it

Node 22+, standard library only, no network:

```sh
node main.ts --input <snapshot.json> --output <dir>
```

or with the grader layout (`/input/snapshot.json` → `/output`), just `node main.ts`.

`main.ts` writes `board.json`, `data.js`, `dashboard/`, `screenshots/`, and `dossier.json` into the output directory, and exits 1 if the board fails its own gate or fewer than 3 screenshots are present.

## What is inside

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes the outputs.
- `lib/model.ts` — the model: snapshot parsing, the ridge fit with leave-one-out and held-out validation, token odds, costed farm plans, board assembly and its gate.
- `dashboard/` — the static dashboard: board, live-token view, model panel, per-protocol detail, and a sandbox that re-ranks the board under different growth/category weights.
- `vendor/makefun-board.ts` — make.fun's dashboard-dossier library, copied byte-for-byte from the bounty kit.
- `screenshots/` — the three required screenshots: board, detail, filtered.
- `METHOD.md` — the full method note.

## Results on the snapshot (14 November 2026)

- 758 protocols; 198 rankable pre-token protocols (all 40 watchlist protocols covered).
- Model fitted on 128 traded comps; leave-one-out R² 0.13, median absolute log error 1.25 (×3.5); held-out R² 0.21.
- The size term carries most of the signal: market cap grows roughly with TVL^0.56.

See `METHOD.md` for the full method, the gas table, and the caveats.
