// Token Launch Radar dashboard. Reads window.RADAR (written by main.ts) and renders the
// board, the live-token view, the model panel and the per-protocol detail. No network.
const D = window.RADAR;
const $ = (id) => document.getElementById(id);
const money = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
  return sign + '$' + Math.round(a);
};
const pct = (v) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');
const age = (d) => (d === null || d === undefined ? '—' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- header facts and lede
$('facts').textContent =
  `Snapshot 14 November 2026 · ${D.meta.protocols_total} protocols · ` +
  `${D.meta.rankable_total} pre-token protocols ranked · ${D.meta.watchlist_ranked} of ` +
  `${D.meta.watchlist_total} watchlist protocols · model fitted on ${D.meta.comps_used} traded comps · ` +
  `all ${D.meta.protocols_total} protocols accounted for in the Census tab · board version ${D.model_version}`;
const m = D.model;
const topRow = D.rows[0];
$('lede').innerHTML =
  `The board ranks every rankable pre-token protocol by <b>expected value</b> — token odds × fitted launch value. ` +
  `Top of the board: <b>${esc(topRow.name)}</b> at ${money(topRow.implied_value_usd)} expected value ` +
  `(${money(topRow.fitted_fdv_usd)} fitted launch value × ${(topRow.token_odds * 100).toFixed(0)}% token odds). ` +
  `The fit explains little of the FDV/TVL spread (leave-one-out R² ${m.loo.r2.toFixed(2)}, median error ×${Math.exp(m.loo.median_abs_log_error).toFixed(1)}), ` +
  `so every value below carries that uncertainty — read the Model &amp; method tab before trusting a row. ` +
  `The ranks themselves are stable: over 200 bootstrap refits the median rank band is ${m.bootstrap.median_band_width} places wide. ` +
  `Farm costs ($50–$250 capital plus gas) are small next to every row's expected value; the binding question is the fitted value and the odds, not the cost.`;

// ---------- filter controls
const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
for (const c of cats) $('category').append(new Option(c, c));
for (const c of chains) $('chain').append(new Option(c, c));

function state() {
  return {
    q: $('q').value.trim().toLowerCase(),
    cat: $('category').value,
    chain: $('chain').value,
    wl: $('watchlist').checked,
    sort: $('sort').value,
  };
}
function filteredRows() {
  const s = state();
  let rows = D.rows.filter((r) =>
    (!s.q || r.name.toLowerCase().includes(s.q) || r.slug.includes(s.q)) &&
    (!s.cat || r.category === s.cat) &&
    (!s.chain || r.chains.includes(s.chain)) &&
    (!s.wl || r.is_watchlist));
  const key = {
    rank: (a, b) => a.rank - b.rank,
    fitted: (a, b) => b.fitted_fdv_usd - a.fitted_fdv_usd,
    odds: (a, b) => b.token_odds - a.token_odds,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    netev: (a, b) => b.farm.net_ev_usd - a.farm.net_ev_usd,
    perhour: (a, b) => b.farm.ev_per_hour_usd - a.farm.ev_per_hour_usd,
  }[s.sort];
  return rows.sort(key);
}
function renderBoard() {
  const rows = filteredRows();
  $('count').textContent = `${rows.length} of ${D.rows.length} protocols shown`;
  $('rows').innerHTML = rows.map((r) => `<tr>
    <td class="num">${r.rank}</td>
    <td class="num">${r.bootstrap_rank_p10 === r.bootstrap_rank_p90 ? r.bootstrap_rank_p10 : r.bootstrap_rank_p10 + '–' + r.bootstrap_rank_p90}</td>
    <td>${r.is_watchlist ? '<span class="star">★</span> ' : ''}${esc(r.name)}<br><span style="color:#5a6478">${esc(r.slug)}</span></td>
    <td>${esc(r.category ?? '—')}</td>
    <td>${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ' +' + (r.chains.length - 2) : ''}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : ''}">${pct(r.change_7d)}</td>
    <td class="num">${age(r.age_days)}</td>
    <td class="num">${money(r.fitted_fdv_usd)}</td>
    <td class="num">${(r.token_odds * 100).toFixed(0)}%</td>
    <td class="num"><b>${money(r.implied_value_usd)}</b></td>
    <td class="num">${money(r.farm.total_cost_usd)}</td>
    <td class="num ${r.farm.net_ev_usd >= 0 ? 'pos' : 'neg'}">${money(r.farm.net_ev_usd)}</td>
    <td class="num ${r.farm.ev_per_hour_usd >= 0 ? 'pos' : 'neg'}">${money(r.farm.ev_per_hour_usd)}</td>
    <td><button class="detail" data-slug="${esc(r.slug)}">Detail</button></td>
  </tr>`).join('');
}
document.querySelectorAll('#rows').forEach((el) => el.addEventListener('click', (e) => {
  const b = e.target.closest('button.detail');
  if (b) openDetail(b.dataset.slug);
}));

// ---------- live view
$('liveRows').innerHTML = D.live.map((r, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td>${esc(r.name)}<br><span style="color:#5a6478">${esc(r.slug)}</span></td>
  <td>${esc(r.category ?? '—')}</td>
  <td class="num">${money(r.tvl_usd)}</td>
  <td class="num">${money(r.mcap_usd)}</td>
  <td class="num">${r.fdv_tvl_ratio.toFixed(3)}</td>
  <td class="num">${age(r.age_days)}</td>
</tr>`).join('');

// ---------- census view
const REASON_LABEL = {
  live_token: 'Already has a token (live, shown on the Live tab)',
  excluded_category: 'Category the watchlist excludes (Bridge, Liquid Staking, CEX, …)',
  versioned_name: 'Versioned name (e.g. “V2”) — likely a redeploy, not a new launch',
  wrapped_or_staked_name: 'Wrapped or staked product name',
  exchange_name: 'Named after an exchange',
};
const census = D.meta.census;
$('censusLede').textContent =
  `${D.meta.protocols_total} protocols in the snapshot: ${census.ranked} ranked on the board, ` +
  `${census.live_token} already live with a token, and ${D.unranked.length - census.live_token} pre-token ` +
  `protocols excluded by the watchlist's own rule. Nothing is silently dropped — every protocol is listed below with its reason.`;
const preTokenExcluded = D.unranked.filter((u) => u.reason !== 'live_token');
$('census').innerHTML = `
<table><thead><tr><th>Fate</th><th>Count</th></tr></thead><tbody>
<tr><td>Ranked on the board</td><td class="num">${census.ranked}</td></tr>
<tr><td>Already has a token (live)</td><td class="num">${census.live_token}</td></tr>
<tr><td>Excluded category</td><td class="num">${census.excluded_category ?? 0}</td></tr>
<tr><td>Versioned name</td><td class="num">${census.versioned_name ?? 0}</td></tr>
<tr><td>Wrapped or staked name</td><td class="num">${census.wrapped_or_staked_name ?? 0}</td></tr>
<tr><td>Named after an exchange</td><td class="num">${census.exchange_name ?? 0}</td></tr>
<tr><td><b>Total</b></td><td class="num"><b>${D.meta.protocols_total}</b></td></tr>
</tbody></table>
<h3>Pre-token protocols excluded, with reasons (${preTokenExcluded.length})</h3>
<div class="tablewrap"><table><thead><tr><th>Protocol</th><th>Category</th><th>TVL</th><th>Reason</th></tr></thead><tbody>
${preTokenExcluded.map((u) => `<tr>
  <td>${esc(u.name)}<br><span style="color:#5a6478">${esc(u.slug)}</span></td>
  <td>${esc(u.category ?? '—')}</td>
  <td class="num">${money(u.tvl_usd)}</td>
  <td>${esc(REASON_LABEL[u.reason] ?? u.reason)}</td>
</tr>`).join('')}
</tbody></table></div>
<p class="note">The ${census.live_token} live-token protocols are listed on the Live tab (top 100 by market cap). Excluded pre-token protocols are not ranked because the watchlist's own rule excludes them — a launch from one of them would still be a launch, but the board only ranks what the watchlist would consider.</p>`;

// ---------- model panel
function coefTable() {
  const rows = m.feature_names.map((n) => {
    const v = m.coefficients[n];
    return `<tr><td>${esc(n)}</td><td class="num">${v.toFixed(3)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Feature</th><th>Coefficient</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function timeSplitRows() {
  return m.time_splits.map((t) => `<tr><td>Walk-forward: ${esc(t.label)} (train ${t.n_train}, test ${t.n_test})</td><td class="num">${t.r2.toFixed(3)}</td><td class="num">${t.median_abs_log_error.toFixed(3)} (×${Math.exp(t.median_abs_log_error).toFixed(2)})</td></tr>`).join('');
}
function benchTimeSplitRows() {
  return m.benchmark_full.time_splits.map((t) => `<tr><td>Walk-forward, 20-feature model: ${esc(t.label)}</td><td class="num">${t.r2.toFixed(3)}</td><td class="num">${t.median_abs_log_error.toFixed(3)} (×${Math.exp(t.median_abs_log_error).toFixed(2)})</td></tr>`).join('');
}
$('model').innerHTML = `
<p>The launch value is fitted, not assumed. The target is <b>log(market cap / TVL)</b> over the
${m.comps_used} traded-token protocols in the snapshot with a positive market cap and TVL (of
${m.comps_total} protocols that record a token at all; one ticker was listed twice — beefy and bifi both
record BIFI — so the smaller row, ${esc(m.comps_dedup_dropped.join(', ') || 'none')}, is dropped and the larger is kept).
The target is winsorised to [${m.target_winsor.join(', ')}] so one legacy protocol with a tiny TVL and a huge
market cap cannot drag the fit. The model is a ridge regression (λ = ${m.lambda}) on <b>log TVL alone</b>.
Fitted launch value = TVL × exp(predicted log ratio), then expected value = token odds × fitted launch value.</p>
<h3>Fitted coefficients</h3>${coefTable()}
<p>The size term is the whole model: the coefficient on log<sub>10</sub> TVL is ${m.coefficients.log10_tvl.toFixed(2)},
so market cap grows roughly with TVL<sup>${(1 + m.coefficients.log10_tvl / Math.LN10).toFixed(2)}</sup> — a
protocol ten times larger in TVL is worth only about ${Math.pow(10, 1 + m.coefficients.log10_tvl / Math.LN10).toFixed(1)}× as much, not 10×.</p>
<h3>Validation</h3>
<table><thead><tr><th>Check</th><th>R²</th><th>Median absolute log error</th></tr></thead><tbody>
<tr><td>Leave-one-out, ${m.comps_used} comps</td><td class="num">${m.loo.r2.toFixed(3)}</td><td class="num">${m.loo.median_abs_log_error.toFixed(3)} (×${Math.exp(m.loo.median_abs_log_error).toFixed(2)})</td></tr>
<tr><td>Held-out 20% (${m.held_out.n_test} comps, split by slug hash)</td><td class="num">${m.held_out.r2.toFixed(3)}</td><td class="num">${m.held_out.median_abs_log_error.toFixed(3)} (×${Math.exp(m.held_out.median_abs_log_error).toFixed(2)})</td></tr>
${timeSplitRows()}
<tr><td>20-feature benchmark, leave-one-out (age, growth, chains, categories)</td><td class="num">${m.benchmark_full.loo.r2.toFixed(3)}</td><td class="num">${m.benchmark_full.loo.median_abs_log_error.toFixed(3)} (×${Math.exp(m.benchmark_full.loo.median_abs_log_error).toFixed(2)})</td></tr>
<tr><td>20-feature benchmark, held-out 20%</td><td class="num">${m.benchmark_full.held_out.r2.toFixed(3)}</td><td class="num">${m.benchmark_full.held_out.median_abs_log_error.toFixed(3)} (×${Math.exp(m.benchmark_full.held_out.median_abs_log_error).toFixed(2)})</td></tr>
${benchTimeSplitRows()}
</tbody></table>
<p>The size-only model beats the 20-feature model on leave-one-out (${m.loo.r2.toFixed(2)} vs ${m.benchmark_full.loo.r2.toFixed(2)})
and on every walk-forward split — the full model scores ${m.benchmark_full.time_splits[2].r2.toFixed(2)} on the newest protocols
while size alone scores ${m.time_splits[2].r2.toFixed(2)}. That is why the board uses size alone: age, growth, chain count
and category were all tried, and none of them survives out of sample. The honest reading is that FDV/TVL is mostly
idiosyncratic, and the board is a ranking of expected values under wide uncertainty, not a price forecast. The median
traded ratio is ${m.median_ratio.toFixed(3)}.</p>
<h3>Rank stability (bootstrap)</h3>
<p>The model was refit ${m.bootstrap.resamples} times on bootstrap resamples of the ${m.comps_used} comps (fixed seed
${m.bootstrap.seed}, so the bands are reproducible). Each row's rank range on the board is the p10–p90 band of its rank
across those refits: the median band is ${m.bootstrap.median_band_width} places wide, the widest is
${m.bootstrap.max_band_width}. The top of the board is stable — the first six rows never leave their rank in any refit —
while the middle of the board moves by a few places. A narrow band means the rank is stable under refitting; it does not
mean the fitted value is precise (median error ×${Math.exp(m.loo.median_abs_log_error).toFixed(1)}).</p>
<h3>Token odds</h3>
<p>Odds are fitted from the snapshot itself: the share of protocols that record a token, by age band and by
category, each shrunk toward the global rate of ${(m && D.odds_model.global_rate * 100).toFixed(1)}% with a
prior of ${D.odds_model.shrink_prior}. Age bands: ${D.odds_model.age_bands.map((b) => `${b.lo}–${b.hi >= 100000 ? '∞' : b.hi}d: ${(b.shrunk * 100).toFixed(0)}% (n=${b.n})`).join(', ')}. The two shrunk rates are averaged and clamped to 5–90%.</p>
<h3>Farm costs</h3>
<p>Capital by TVL tier: &lt;$50M → $50, &lt;$250M → $100, &lt;$1B → $150, else $250. Gas per transaction is a
stated typical for November 2026 (Ethereum $8.00, Arbitrum $0.15, Base $0.08, Solana $0.01, and so on — see
METHOD.md in the repository); each plan pays a $2 bridge fee each way plus one gas charge per on-chain step.
Hold is 30 days for protocols under 6 months old, 45 days under 2 years, 60 days older. Active hours count
setup plus 15 minutes per on-chain step and per weekly claim; the hold itself is passive. Break-even launch
value = farm cost ÷ token odds.</p>`;

// ---------- sandbox
function sandboxRank() {
  const slope = parseFloat($('wSlope').value);
  $('wSlopeVal').textContent = slope.toFixed(2);
  const coef = m.coefficients.log10_tvl;
  const re = D.rows.map((r) => {
    const c = r.model_contributions;
    const logRatio = c.intercept + (slope / coef) * c.log10_tvl;
    const fdv = Math.max(1, Math.round(r.tvl_usd * Math.exp(Math.min(3, Math.max(-6, logRatio)))));
    return { slug: r.slug, name: r.name, ev: Math.round(fdv * r.token_odds), fdv };
  }).sort((a, b) => b.ev - a.ev);
  const top3 = re.slice(0, 3).map((r, i) => `${i + 1}. ${r.name} (${money(r.ev)})`).join(' · ');
  const baseTop = D.rows[0].name;
  $('sandboxNote').textContent = `With slope ${slope.toFixed(2)} the top 3 are: ${top3}. Base fit (slope ${coef.toFixed(2)}) top: ${baseTop}. ` +
    (re[0].name === baseTop ? 'The leader is unchanged.' : 'The leader changes — the ranking is sensitive to the size slope.');
}
$('wSlope').value = String(m.coefficients.log10_tvl);
$('wSlope').addEventListener('input', sandboxRank);
sandboxRank();

// ---------- detail dialog
function openDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug);
  if (!r) return;
  const c = r.model_contributions;
  const contribRows = [
    ['Intercept', c.intercept],
    ['Size (log₁₀ TVL)', c.log10_tvl],
  ].map(([k, v]) => `<tr><td>${k}</td><td class="num">${v.toFixed(3)}</td></tr>`).join('');
  $('detailBody').innerHTML = `
    <h2>${r.is_watchlist ? '★ ' : ''}${esc(r.name)}</h2>
    <p>${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.join(', '))} · TVL ${money(r.tvl_usd)} · 7d ${pct(r.change_7d)} · age ${age(r.age_days)} · ${r.is_watchlist ? 'on the watchlist' : 'below the watchlist floor'}</p>
    <h3>Expected value</h3>
    <table><tbody>
      <tr><td>Fitted launch value (TVL × fitted ratio ${r.fitted_ratio})</td><td class="num">${money(r.fitted_fdv_usd)}</td></tr>
      <tr><td>Token odds</td><td class="num">${(r.token_odds * 100).toFixed(1)}%</td></tr>
      <tr><td><b>Expected value</b></td><td class="num"><b>${money(r.implied_value_usd)}</b></td></tr>
      <tr><td>Bootstrap rank band (p10–p90 over 200 refits)</td><td class="num">${r.bootstrap_rank_p10 === r.bootstrap_rank_p90 ? 'rank ' + r.bootstrap_rank_p10 + ' in every refit' : 'ranks ' + r.bootstrap_rank_p10 + '–' + r.bootstrap_rank_p90}</td></tr>
      <tr><td>Farm cost (capital ${money(r.farm.capital_usd)} + gas ${money(r.farm.gas_usd)})</td><td class="num">${money(r.farm.total_cost_usd)}</td></tr>
      <tr><td>Net expected value</td><td class="num ${r.farm.net_ev_usd >= 0 ? 'pos' : 'neg'}">${money(r.farm.net_ev_usd)}</td></tr>
      <tr><td>Break-even launch value</td><td class="num">${money(r.farm.break_even_fdv_usd)}</td></tr>
      <tr><td>Active hours / expected value per hour</td><td class="num">${r.farm.active_hours}h · ${money(r.farm.ev_per_hour_usd)}/h</td></tr>
    </tbody></table>
    <h3>Model breakdown (log ratio ${r.model_log_ratio})</h3>
    <table><tbody>${contribRows}</tbody></table>
    <h3>Farm plan</h3>
    <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="warn">This is a plan for genuine use of a real protocol, not a promise of an airdrop. The snapshot records no token for this protocol; it does not say the protocol will ever issue one.</p>`;
  $('detail').showModal();
  $('detail').scrollTop = 0;
  history.replaceState(null, '', '#p=' + slug);
}
$('closeDetail').addEventListener('click', () => { $('detail').close(); history.replaceState(null, '', location.hash.replace(/[#&]p=[^&]*/g, '') || '#'); });
$('detail').addEventListener('close', () => { history.replaceState(null, '', location.hash.replace(/[#&]p=[^&]*/g, '') || '#'); });

// ---------- tabs and hash state
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['board', 'live', 'model', 'census'].forEach((t) => { $('tab-' + t).hidden = t !== name; });
  history.replaceState(null, '', '#tab=' + name);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
['q', 'category', 'chain', 'watchlist', 'sort'].forEach((id) => $(id).addEventListener('input', renderBoard));
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('q')) $('q').value = h.get('q');
  if (h.get('category')) $('category').value = h.get('category');
  if (h.get('chain')) $('chain').value = h.get('chain');
  if (h.get('watchlist')) $('watchlist').checked = h.get('watchlist') === '1';
  if (h.get('sort')) $('sort').value = h.get('sort');
  if (h.get('tab')) showTab(h.get('tab'));
  if (h.get('p')) openDetail(h.get('p'));
}
readHash();
renderBoard();
