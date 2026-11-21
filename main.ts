// radar-2 entrypoint: build the token launch radar from the snapshot.
//   node main.ts [--input path] [--output dir]
//   MAKEFUN_OUTPUT_DIR overrides the output directory (default /output).
// Reads the snapshot, fits the launch model, writes board.json, data.js, copies
// dashboard/ into the output directory, decodes screenshots/ (*.png.b64, single-line
// base64 — the repo ships the shots as text because the push path cannot carry binary
// files) into the output's screenshots/ as PNGs, and writes dossier.json.
// Exits 1 when the board fails its own gate or fewer than 3 screenshots are present.
// Node 22+, standard library only, no network, no clock, no randomness: two runs
// over the same snapshot produce byte-identical outputs.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildBoard, boardIssue } from './lib/model.ts';
import { buildDossier, canonicalJson } from './vendor/makefun-board.ts';

const TEXT_MAX_BYTES = 65536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 512 * 1024 };
const DASHBOARD_CAPS = { max_files: 40, max_bytes: 1024 * 1024 };

function parseArgs(argv: string[]): { input: string; output: string | null } {
  let input = '/input/snapshot.json';
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i];
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i];
    else if (argv[i]?.startsWith('--input=')) input = argv[i].slice('--input='.length);
    else if (argv[i]?.startsWith('--output=')) output = argv[i].slice('--output='.length);
  }
  return { input, output };
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const outDir = resolve(output ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const here = new URL('.', import.meta.url).pathname;

  const snapshot = JSON.parse(readFileSync(input, 'utf8'));
  const board = buildBoard(snapshot);

  const issue = boardIssue(board, snapshot.watchlist);
  if (issue !== null) {
    console.error(`board gate failed: ${issue}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), canonicalJson(board), 'utf8');
  writeFileSync(
    join(outDir, 'data.js'),
    `window.RADAR = ${JSON.stringify(board)};\n`,
    'utf8',
  );

  const dashSrc = join(here, 'dashboard');
  if (existsSync(dashSrc)) copyTree(dashSrc, join(outDir, 'dashboard'));
  // Screenshots ship as single-line base64 (*.png.b64); decode each into the
  // output's screenshots/ as its PNG. Pure decode: byte-identical every run.
  const shotsSrc = join(here, 'screenshots');
  if (existsSync(shotsSrc)) {
    mkdirSync(join(outDir, 'screenshots'), { recursive: true });
    for (const e of readdirSync(shotsSrc, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.png.b64')) continue;
      const b64 = readFileSync(join(shotsSrc, e.name), 'utf8').replace(/\s+/g, '');
      writeFileSync(join(outDir, 'screenshots', e.name.slice(0, -4)), Buffer.from(b64, 'base64'));
    }
  }

  const shotsDir = join(outDir, 'screenshots');
  const shots = existsSync(shotsDir)
    ? readdirSync(shotsDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.'))
    : [];
  if (shots.length < 3) {
    console.error(`screenshot gate failed: ${shots.length} screenshot(s), expected at least 3`);
    process.exit(1);
  }

  const dossier = buildDossier(outDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: DASHBOARD_CAPS,
  });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  console.log(`board: ${board.rows.length} ranked rows, ${board.meta.watchlist_ranked}/${board.meta.watchlist_total} watchlist covered`);
  console.log(`census: ${board.meta.protocols_total} accounted (${board.meta.census.ranked} ranked, ${board.meta.census.live_token ?? 0} live, ${board.unranked.length - (board.meta.census.live_token ?? 0)} pre-token excluded)`);
  console.log(`model: ridge lambda ${board.model.lambda}, ${board.model.comps_used} comps, LOO R2 ${board.model.loo.r2.toFixed(3)}, held-out R2 ${board.model.held_out.r2.toFixed(3)}, time-splits ${board.model.time_splits.map((t) => t.r2.toFixed(2)).join('/')}`);
  console.log(`bootstrap: ${board.model.bootstrap.resamples} refits, median rank band ${board.model.bootstrap.median_band_width}, max ${board.model.bootstrap.max_band_width}`);
  console.log(`top EV: ${board.rows[0].name} $${board.rows[0].implied_value_usd.toLocaleString('en-US')}`);
  console.log(`screenshots: ${shots.length}, dossier: ${dossier.length} bytes`);
  console.log(`wrote ${outDir}`);
}

main();
