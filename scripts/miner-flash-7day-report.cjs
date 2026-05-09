// 7-day pre/post-flash report for Main (192.168.0.73), comparing
// against Main2 (192.168.0.40) as the matched-hardware control.
// Reads pre-flash baseline from the May 2 snapshot file and the
// post-flash week from the live history.json.
const fs = require('node:fs');

const FLASH_TS = new Date('2026-05-02T01:00:00Z').getTime();
const ONE_DAY = 24 * 3600 * 1000;
const PRE_PATH  = 'C:/Users/Owner/miner-dashboard/history-pre-flash-2026-05-02.json';
const LIVE_PATH = 'C:/Users/Owner/miner-dashboard/history.json';

function load(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { console.error('Failed to read', path, ':', e.message); return []; }
}

function summarise(snapshots, ip, fromTs, toTs) {
  const acc = { count: 0, offline: 0, hash: [], power: [], temp: [], eff: [], reject: [], totalAccepted: 0, totalRejected: 0, hwErrors: 0 };
  for (const s of snapshots) {
    if (s.ts < fromTs || s.ts > toTs) continue;
    const m = (s.miners || {})[ip];
    if (!m) continue;
    if (m.online === false) { acc.offline++; continue; }
    acc.count++;
    if (typeof m.hashrate === 'number') acc.hash.push(m.hashrate);
    if (typeof m.power === 'number') acc.power.push(m.power);
    if (typeof m.maxChipTemp === 'number') acc.temp.push(m.maxChipTemp);
    if (typeof m.efficiency === 'number') acc.eff.push(m.efficiency);
    if (typeof m.accepted === 'number') acc.totalAccepted = Math.max(acc.totalAccepted, m.accepted);
    if (typeof m.rejected === 'number') acc.totalRejected = Math.max(acc.totalRejected, m.rejected);
    if (typeof m.hwErrors === 'number') acc.hwErrors = Math.max(acc.hwErrors, m.hwErrors);
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const total = acc.count + acc.offline;
  return {
    samples: acc.count,
    offline: acc.offline,
    uptimePct: total > 0 ? (acc.count / total) * 100 : null,
    avgHashrate: mean(acc.hash),
    avgPower: mean(acc.power),
    avgTemp: mean(acc.temp),
    avgEfficiency: mean(acc.eff),
    rejectRate: (acc.totalAccepted + acc.totalRejected) > 0
      ? (acc.totalRejected / (acc.totalAccepted + acc.totalRejected)) * 100
      : null,
  };
}

function fmt(v, unit, dp = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(dp) + unit;
}
function delta(before, after, lowerIsBetter, unit, dp = 2) {
  if (before == null || after == null) return '—';
  const d = after - before;
  const pct = (d / before) * 100;
  const better = lowerIsBetter ? d < 0 : d > 0;
  const arrow = d >= 0 ? '+' : '';
  const verdict = Math.abs(pct) < 0.5 ? '≈' : (better ? '✓' : '✗');
  return `${arrow}${d.toFixed(dp)}${unit} (${arrow}${pct.toFixed(1)}%) ${verdict}`;
}

const pre  = load(PRE_PATH);
const live = load(LIVE_PATH);
console.log(`Loaded pre-flash snapshots: ${pre.length}, live snapshots: ${live.length}`);

// Pre-flash: 7 days *ending at* the flash timestamp, from the snapshot file
const preStart = FLASH_TS - 7 * ONE_DAY;
const preEnd   = FLASH_TS;

// Post-flash: from the flash timestamp to now, capped at 7 days
const now = Date.now();
const postStart = FLASH_TS;
const postEnd   = Math.min(now, FLASH_TS + 7 * ONE_DAY);

const preMain   = summarise(pre,  '192.168.0.73', preStart, preEnd);
const postMain  = summarise(live, '192.168.0.73', postStart, postEnd);
const postMain2 = summarise(live, '192.168.0.40', postStart, postEnd);

const preDays  = (preEnd - preStart) / ONE_DAY;
const postDays = (postEnd - postStart) / ONE_DAY;

console.log('');
console.log('# Miner Flash 7-Day Report');
console.log('');
console.log(`**Flash event:** Main flashed from stock to Braiins on 2026-05-02 ~01:00 UTC.`);
console.log(`**Pre-flash window:** ${preDays.toFixed(2)} days ending ${new Date(preEnd).toISOString()} (Main on STOCK, ${preMain.samples} samples)`);
console.log(`**Post-flash window:** ${postDays.toFixed(2)} days from flash (Main on BRAIINS, ${postMain.samples} samples)`);
console.log('');
console.log('## 4-column comparison');
console.log('');
console.log('| Metric | Main pre-flash (STOCK) | Main post-flash (BRAIINS) | Main2 same week (BRAIINS, control) | Main Δ pre→post |');
console.log('|---|---|---|---|---|');
console.log(`| Avg hashrate | ${fmt(preMain.avgHashrate, ' TH/s')} | ${fmt(postMain.avgHashrate, ' TH/s')} | ${fmt(postMain2.avgHashrate, ' TH/s')} | ${delta(preMain.avgHashrate, postMain.avgHashrate, false, ' TH/s')} |`);
console.log(`| Avg power | ${fmt(preMain.avgPower, ' W', 0)} | ${fmt(postMain.avgPower, ' W', 0)} | ${fmt(postMain2.avgPower, ' W', 0)} | ${delta(preMain.avgPower, postMain.avgPower, true, ' W', 0)} |`);
console.log(`| Avg efficiency | ${fmt(preMain.avgEfficiency, ' J/TH')} | ${fmt(postMain.avgEfficiency, ' J/TH')} | ${fmt(postMain2.avgEfficiency, ' J/TH')} | ${delta(preMain.avgEfficiency, postMain.avgEfficiency, true, ' J/TH')} |`);
console.log(`| Avg max chip temp | ${fmt(preMain.avgTemp, '°C')} | ${fmt(postMain.avgTemp, '°C')} | ${fmt(postMain2.avgTemp, '°C')} | ${delta(preMain.avgTemp, postMain.avgTemp, true, '°C')} |`);
console.log(`| Reject rate | ${fmt(preMain.rejectRate, '%', 3)} | ${fmt(postMain.rejectRate, '%', 3)} | ${fmt(postMain2.rejectRate, '%', 3)} | — |`);
console.log(`| Uptime % | ${fmt(preMain.uptimePct, '%')} | ${fmt(postMain.uptimePct, '%')} | ${fmt(postMain2.uptimePct, '%')} | — |`);
console.log('');

// Predicted-gain check
console.log('## Predicted-gain check (Apr 29 baseline forecast)');
const tempGap = preMain.avgTemp - postMain.avgTemp;
const effPctChange = ((postMain.avgEfficiency - preMain.avgEfficiency) / preMain.avgEfficiency) * 100;
console.log(`- Predicted ~6°C cooler post-flash: actual delta = ${tempGap.toFixed(2)}°C → ${tempGap >= 5.5 ? '✓ MET' : tempGap >= 4 ? '◐ partial' : '✗ MISSED'}`);
console.log(`- Predicted ~5% efficiency improvement: actual = ${effPctChange.toFixed(1)}% → ${effPctChange <= -4.5 ? '✓ MET' : effPctChange <= -2 ? '◐ partial' : '✗ MISSED'}`);
console.log('');

// Heatsink concern
console.log('## Heatsink concern check');
const tempGapMain_vs_Main2 = postMain.avgTemp - postMain2.avgTemp;
console.log(`- Main historical max chip temp on stock: ~86°C (vs Main2's ~80°C, +6°C gap)`);
console.log(`- Main avg max chip on Braiins (post-flash): ${postMain.avgTemp.toFixed(2)}°C`);
console.log(`- Main2 avg max chip on Braiins (same week): ${postMain2.avgTemp.toFixed(2)}°C`);
console.log(`- Main vs Main2 same-firmware gap: ${tempGapMain_vs_Main2 >= 0 ? '+' : ''}${tempGapMain_vs_Main2.toFixed(2)}°C`);
let heatsinkVerdict;
if (Math.abs(tempGapMain_vs_Main2) < 1.5) heatsinkVerdict = '✓ Closed — same firmware = same temps. The pre-flash gap was a stock-firmware tuning artifact, not a hardware/airflow problem.';
else if (tempGapMain_vs_Main2 < -1.5) heatsinkVerdict = '✓ Main now runs cooler than Main2 — no hardware service warranted.';
else if (tempGapMain_vs_Main2 < 3) heatsinkVerdict = '◐ Mostly closed but Main still slightly hotter — borderline, monitor over next month before committing to a service.';
else heatsinkVerdict = '✗ Main still runs noticeably hotter than Main2 on identical firmware — heatsink/paste/airflow on Main worth a physical service.';
console.log(`- Verdict: ${heatsinkVerdict}`);
console.log('');

// Verdict
console.log('## Was the flash worth it?');
const hashLoss = preMain.avgHashrate - postMain.avgHashrate;
const powerSaved = preMain.avgPower - postMain.avgPower;
const effGain = preMain.avgEfficiency - postMain.avgEfficiency;
console.log('');
const summary = [];
if (effGain > 0.5) summary.push(`efficiency improved by ${effGain.toFixed(2)} J/TH (${(effGain/preMain.avgEfficiency*100).toFixed(1)}%)`);
if (powerSaved > 50) summary.push(`power draw fell by ${powerSaved.toFixed(0)} W (${(powerSaved/preMain.avgPower*100).toFixed(1)}%)`);
if (Math.abs(hashLoss) > 1) summary.push(`hashrate ${hashLoss > 0 ? 'dropped' : 'rose'} by ${Math.abs(hashLoss).toFixed(2)} TH/s`);
if (tempGap > 2) summary.push(`max chip temp dropped ${tempGap.toFixed(1)}°C`);

const verdict = (effGain > 0 && tempGap > 0)
  ? '**WORTH IT.**'
  : (effGain > 0 || tempGap > 0)
  ? '**MIXED — partially worth it.**'
  : '**NOT WORTH IT.**';

console.log(verdict, summary.join(', ') + '.');

// Daily-energy savings extrapolation
if (powerSaved > 0) {
  const dailyKwhSaved = (powerSaved * 24) / 1000;
  const yearlyKwhSaved = dailyKwhSaved * 365;
  console.log('');
  console.log(`At a typical UK electricity rate of £0.27/kWh, that's ${dailyKwhSaved.toFixed(2)} kWh/day saved → £${(dailyKwhSaved * 0.27).toFixed(2)}/day → £${(yearlyKwhSaved * 0.27).toFixed(0)}/year on Main alone.`);
}
