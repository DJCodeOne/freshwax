// Generate a monthly artist/label statement PDF using REAL data gathered
// by scripts/gather-monthly-report-data.cjs (writes monthly-report-data.json).
// Sections without data are skipped rather than faked. Styled in Fresh Wax
// brand (dark + red WAX accent). Uses Playwright to render HTML → PDF.
//
// Usage:
//   1. node scripts/gather-monthly-report-data.cjs <artistId> <year> <month>
//   2. node scripts/generate-artist-monthly-report.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const DATA_PATH = path.resolve(__dirname, 'monthly-report-data.json');
if (!fs.existsSync(DATA_PATH)) {
  console.error(`Missing ${DATA_PATH}. Run gather-monthly-report-data.cjs first.`);
  process.exit(1);
}
const REPORT = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

// ---- Helpers --------------------------------------------------------
function gbp(n) { return '£' + Number(n || 0).toFixed(2); }
function pctChange(a, b) {
  if (!b) return null;
  return ((a - b) / b * 100);
}
function escape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function dailyRevenueChart(data) {
  const w = 720, h = 140, pad = 18;
  const max = Math.max(...data, 1);
  const bw = (w - pad * 2) / data.length;
  const bars = data.map((v, i) => {
    const bh = v > 0 ? (v / max) * (h - pad * 2) : 0;
    const x = pad + i * bw;
    const y = h - pad - bh;
    if (bh === 0) return '';
    return `<rect x="${x + 1}" y="${y}" width="${bw - 2}" height="${bh}" fill="#ef4444" opacity="${0.6 + (v / max) * 0.4}" rx="1.5"/>`;
  }).join('');
  // Empty-day baseline ticks
  const baseline = data.map((v, i) => {
    if (v > 0) return '';
    const x = pad + i * bw + bw / 2;
    return `<circle cx="${x}" cy="${h - pad}" r="0.8" fill="#2a2a2a"/>`;
  }).join('');
  const axis = `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#3a3a3a" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg">${axis}${baseline}${bars}</svg>`;
}

function pctBar(p) {
  return `<div class="pct-bar"><div class="pct-bar-fill" style="width:${p}%"></div></div>`;
}

// ---- HTML template --------------------------------------------------
function buildHtml(r) {
  const grossDelta = pctChange(r.grossRevenue, r.prior.grossRevenue);
  const netDelta = pctChange(r.netEarnings, r.prior.netEarnings);
  const salesDelta = pctChange(r.totalSales, r.prior.totalSales);
  const hasPriorComparison = r.prior.totalSales > 0 || r.prior.grossRevenue > 0;

  const totalDays = r.dailyRevenue.length;
  const activeDays = r.dailyRevenue.filter(v => v > 0).length;
  const peakDay = Math.max(...r.dailyRevenue);
  const avgDay = r.dailyRevenue.reduce((a, b) => a + b, 0) / Math.max(1, totalDays);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escape(r.artistName)} — Monthly Statement ${escape(r.period)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a;
    color: #e5e5e5;
    font-size: 10pt;
    line-height: 1.45;
  }
  .page {
    padding: 10mm 14mm 10mm;
    background: #0a0a0a;
  }
  .page + .page {
    page-break-before: always;
  }
  h2 { page-break-after: avoid; }
  table.data, .waterfall, .stats-row, .chart-card { page-break-inside: avoid; }

  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #2a2a2a;
    padding-bottom: 8px;
    margin-bottom: 12px;
  }
  .brand-mark {
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: 26pt;
    letter-spacing: 1px;
    line-height: 1;
  }
  .brand-mark .fresh { color: #fff; }
  .brand-mark .wax { color: #ef4444; }
  .doc-title {
    text-align: right;
    color: #888;
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 1.5px;
  }
  .doc-title strong { color: #fff; font-size: 12pt; display: block; margin-bottom: 2px; }

  .recipient {
    background: linear-gradient(135deg, #1a1a1a 0%, #141414 100%);
    border-left: 3px solid #ef4444;
    padding: 10px 16px;
    margin-bottom: 14px;
    border-radius: 4px;
  }
  .recipient h1 { margin: 0 0 4px; font-size: 18pt; color: #fff; font-weight: 600; }
  .recipient .meta { color: #999; font-size: 9pt; }
  .recipient .meta span { margin-right: 14px; }
  .recipient .meta strong { color: #bbb; }

  h2 {
    font-size: 10.5pt;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #ef4444;
    margin: 14px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #2a2a2a;
    font-weight: 600;
  }
  h2 .sub {
    float: right;
    color: #666;
    font-size: 8.5pt;
    text-transform: none;
    letter-spacing: 0;
    font-weight: normal;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 6px;
  }
  .stat-card {
    background: #141414;
    border: 1px solid #232323;
    border-radius: 6px;
    padding: 12px 14px;
  }
  .stat-card.primary { border-color: #ef4444; background: linear-gradient(135deg, rgba(239,68,68,0.08) 0%, #141414 60%); }
  .stat-card.success { border-color: #16a34a; background: linear-gradient(135deg, rgba(22,163,74,0.08) 0%, #141414 60%); }
  .stat-card .label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1px; color: #888; }
  .stat-card .value { font-size: 18pt; color: #fff; font-weight: 700; line-height: 1.2; margin-top: 4px; }
  .stat-card .delta { font-size: 8pt; margin-top: 4px; color: #777; }
  .delta.up { color: #4ade80; }
  .delta.down { color: #f87171; }

  .waterfall {
    background: #141414;
    border: 1px solid #232323;
    border-radius: 6px;
    padding: 14px 18px;
  }
  .waterfall-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 6px 0;
    font-size: 10pt;
  }
  .waterfall-row + .waterfall-row { border-top: 1px solid #1f1f1f; }
  .waterfall-row.total { border-top: 2px solid #ef4444; padding-top: 10px; margin-top: 4px; }
  .waterfall-row.total .label { color: #fff; font-weight: 600; }
  .waterfall-row.total .amount { color: #4ade80; font-size: 14pt; font-weight: 700; }
  .waterfall-row .label { color: #aaa; }
  .waterfall-row .amount { color: #ddd; font-variant-numeric: tabular-nums; }
  .waterfall-row .amount.negative { color: #f87171; }

  table.data {
    width: 100%;
    border-collapse: collapse;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 6px;
    overflow: hidden;
    font-size: 9.5pt;
  }
  table.data thead th {
    background: #1c1c1c;
    color: #ef4444;
    text-align: left;
    text-transform: uppercase;
    font-size: 7.5pt;
    letter-spacing: 1px;
    padding: 10px 14px;
    font-weight: 600;
  }
  table.data td {
    padding: 10px 14px;
    border-top: 1px solid #1f1f1f;
    color: #ddd;
    vertical-align: middle;
  }
  table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data .release-title { color: #fff; font-weight: 500; }
  table.data .release-artist { color: #888; font-size: 8.5pt; display: block; }
  table.data tr.release-row td { background: #161616; }
  table.data tr.track-row td {
    padding-top: 5px;
    padding-bottom: 5px;
    background: #101010;
    border-top: 1px solid #1a1a1a;
    color: #aaa;
    font-size: 9pt;
  }
  table.data tr.track-row td.track-title { padding-left: 36px; position: relative; }
  table.data tr.track-row td.track-title::before {
    content: "↳";
    position: absolute;
    left: 22px;
    color: #555;
    font-size: 8pt;
  }
  table.data tr.track-row td.num { color: #999; }

  .category-row {
    display: grid;
    grid-template-columns: 1.6fr 0.6fr 0.9fr 2.1fr 0.5fr;
    align-items: center;
    gap: 10px;
    padding: 7px 0;
    font-size: 9.5pt;
  }
  .category-row + .category-row { border-top: 1px solid #1f1f1f; }
  .pct-bar {
    height: 6px;
    background: #1f1f1f;
    border-radius: 3px;
    overflow: hidden;
  }
  .pct-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #ef4444 0%, #fb923c 100%);
    border-radius: 3px;
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 6px;
    padding: 14px 16px;
  }
  .stat-mini { text-align: center; }
  .stat-mini .v { font-size: 14pt; color: #fff; font-weight: 700; }
  .stat-mini .l { font-size: 7.5pt; color: #888; text-transform: uppercase; letter-spacing: 0.8px; margin-top: 2px; }

  .chart-card {
    background: #141414;
    border: 1px solid #232323;
    border-radius: 6px;
    padding: 14px 16px;
  }
  .chart-meta {
    display: flex;
    justify-content: space-between;
    color: #888;
    font-size: 8pt;
    margin-top: 8px;
  }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 600;
  }
  .pill.paid { background: rgba(22,163,74,0.15); color: #4ade80; border: 1px solid rgba(22,163,74,0.4); }
  .pill.scheduled { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }
  .pill.pending { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }

  .empty-note {
    background: #141414;
    border: 1px dashed #2a2a2a;
    border-radius: 6px;
    padding: 16px;
    color: #777;
    font-size: 9pt;
    text-align: center;
  }

  footer {
    margin-top: 26px;
    padding-top: 14px;
    border-top: 1px solid #2a2a2a;
    color: #666;
    font-size: 8pt;
    line-height: 1.6;
  }
  footer strong { color: #aaa; }
  footer .red { color: #ef4444; }
</style>
</head>
<body>

<!-- =================== PAGE 1 =================== -->
<div class="page">

  <div class="brand-row">
    <div class="brand-mark"><span class="fresh">FRESH</span><span class="wax">WAX</span></div>
    <div class="doc-title">
      <strong>Monthly Statement</strong>
      ${escape(r.period)}
    </div>
  </div>

  <div class="recipient">
    <h1>${escape(r.artistName)}</h1>
    <div class="meta">
      <span><strong>Account:</strong> ${escape(r.artistEmail)}</span>
      <span><strong>Period:</strong> ${escape(r.periodStart)} → ${escape(r.periodEnd)}</span>
      <span><strong>Generated:</strong> ${escape(r.generatedAt.split('T')[0])}</span>
    </div>
  </div>

  <h2>Top-Line Performance ${hasPriorComparison ? '<span class="sub">vs. previous month</span>' : '<span class="sub">no prior-month data</span>'}</h2>
  <div class="stats-grid">
    <div class="stat-card primary">
      <div class="label">Gross Revenue</div>
      <div class="value">${gbp(r.grossRevenue)}</div>
      <div class="delta${grossDelta == null ? '' : grossDelta >= 0 ? ' up' : ' down'}">${grossDelta == null ? 'First active month' : `${grossDelta >= 0 ? '▲' : '▼'} ${grossDelta.toFixed(1)}% vs. ${gbp(r.prior.grossRevenue)}`}</div>
    </div>
    <div class="stat-card success">
      <div class="label">Net Earnings</div>
      <div class="value">${gbp(r.netEarnings)}</div>
      <div class="delta${netDelta == null ? '' : netDelta >= 0 ? ' up' : ' down'}">${netDelta == null ? 'After Fresh Wax + processing fees' : `${netDelta >= 0 ? '▲' : '▼'} ${netDelta.toFixed(1)}% vs. ${gbp(r.prior.netEarnings)}`}</div>
    </div>
    <div class="stat-card">
      <div class="label">Orders</div>
      <div class="value">${r.totalSales}</div>
      <div class="delta">${r.totalUnits} item${r.totalUnits === 1 ? '' : 's'} sold</div>
    </div>
    <div class="stat-card">
      <div class="label">Pending Payout</div>
      <div class="value">${gbp(r.pendingBalance)}</div>
      <div class="delta">Releases on next cycle</div>
    </div>
  </div>

  <h2>Daily Revenue <span class="sub">${totalDays} days · ${activeDays} active</span></h2>
  <div class="chart-card">
    ${dailyRevenueChart(r.dailyRevenue)}
    <div class="chart-meta">
      <span>${escape(r.periodStart)}</span>
      <span>Peak day: ${gbp(peakDay)} · Avg: ${gbp(avgDay)}</span>
      <span>${escape(r.periodEnd)}</span>
    </div>
  </div>

  <h2>Earnings Waterfall <span class="sub">how gross becomes net</span></h2>
  <div class="waterfall">
    <div class="waterfall-row"><span class="label">Gross Revenue</span><span class="amount">${gbp(r.grossRevenue)}</span></div>
    <div class="waterfall-row"><span class="label">Fresh Wax platform fee (1%)</span><span class="amount negative">−${gbp(r.freshWaxFee)}</span></div>
    <div class="waterfall-row"><span class="label">Payment processing fees (PayPal / Stripe)</span><span class="amount negative">−${gbp(r.paymentProcessingFee)}</span></div>
    ${r.refunds > 0 ? `<div class="waterfall-row"><span class="label">Refunds</span><span class="amount negative">−${gbp(r.refunds)}</span></div>` : ''}
    <div class="waterfall-row total"><span class="label">Net Earnings</span><span class="amount">${gbp(r.netEarnings)}</span></div>
  </div>

  ${r.byCategory.length > 0 ? `
  <h2>Sales by Category</h2>
  <div class="waterfall" style="padding: 4px 18px;">
    <div class="category-row" style="padding-bottom: 8px; border-bottom: 1px solid #1f1f1f; font-size: 7.5pt; text-transform: uppercase; color: #666; letter-spacing: 1px;">
      <span>Category</span>
      <span class="num" style="text-align:right">Units</span>
      <span class="num" style="text-align:right">Gross</span>
      <span>Share</span>
      <span class="num" style="text-align:right">%</span>
    </div>
    ${r.byCategory.map(c => `
    <div class="category-row">
      <span style="color:#fff">${escape(c.type)}</span>
      <span class="num" style="text-align:right; color:#bbb">${c.units}</span>
      <span class="num" style="text-align:right; color:#fff">${gbp(c.gross)}</span>
      ${pctBar(c.share)}
      <span class="num" style="text-align:right; color:#888">${c.share}%</span>
    </div>`).join('')}
  </div>` : ''}

  <footer>
    <strong>Fresh<span class="red">Wax</span></strong> · freshwax.co.uk · For questions about this statement contact support@freshwax.co.uk
  </footer>
</div>

<!-- =================== PAGE 2 =================== -->
<div class="page">

  <div class="brand-row">
    <div class="brand-mark"><span class="fresh">FRESH</span><span class="wax">WAX</span></div>
    <div class="doc-title">
      <strong>${escape(r.artistName)}</strong>
      ${escape(r.period)}
    </div>
  </div>

  ${r.topReleases.length > 0 ? `
  <h2>Top Releases This Period <span class="sub">ranked by units sold · tracks listed below each release</span></h2>
  <table class="data">
    <thead>
      <tr><th>#</th><th>Release / Track</th><th class="num">Units</th><th class="num">Gross</th><th class="num">Tracks Sold</th></tr>
    </thead>
    <tbody>
      ${r.topReleases.map((rel, i) => {
        const total = rel.totalTracks || 0;
        const distinct = rel.distinctTracksSold || 0;
        const coverPct = total > 0 ? Math.round((distinct / total) * 100) : 0;
        const coverage = total > 0
          ? `${distinct} / ${total} <span style="color:#666; font-size:8.5pt">(${coverPct}%)</span>`
          : `${distinct}`;
        return `
      <tr class="release-row">
        <td style="color:#666; width: 30px;">${i + 1}</td>
        <td>
          <span class="release-title">${escape(rel.title)}</span>
          <span class="release-artist">${escape(rel.artist)}</span>
        </td>
        <td class="num">${rel.units}</td>
        <td class="num">${gbp(rel.gross)}</td>
        <td class="num">${coverage}</td>
      </tr>
      ${(rel.tracks || []).map(t => `
      <tr class="track-row">
        <td></td>
        <td class="track-title">${escape(t.title || '—')}</td>
        <td class="num">${t.units}</td>
        <td class="num">${gbp(t.gross)}</td>
        <td class="num"></td>
      </tr>`).join('')}
      `;
      }).join('')}
    </tbody>
  </table>` : ''}

  <h2>Catalog &amp; Listener Activity</h2>
  <div class="stats-row">
    <div class="stat-mini"><div class="v">${r.catalogSize}</div><div class="l">Live Releases</div></div>
    <div class="stat-mini"><div class="v">${r.listenerStats.mixCount}</div><div class="l">Published Mixes</div></div>
    <div class="stat-mini"><div class="v">${r.listenerStats.totalPlays.toLocaleString()}</div><div class="l">Total Mix Plays</div></div>
    <div class="stat-mini"><div class="v">${r.listenerStats.totalFollowers}</div><div class="l">Followers</div></div>
  </div>
  <div style="color:#666; font-size:8pt; margin-top:6px; text-align:right">Listener-level analytics (unique listeners, completion %, geographic split) are not yet collected — coming soon.</div>

  <h2>All-Time Summary <span class="sub">${r.lifetime.firstSaleDate ? `active since ${escape(r.lifetime.firstSaleDate)} · ${r.lifetime.monthsActive} ${r.lifetime.monthsActive === 1 ? 'month' : 'months'} with sales` : 'no sales recorded yet'}</span></h2>
  ${r.lifetime.totalSales > 0 ? `
  <div class="stats-row" style="grid-template-columns: repeat(5, 1fr);">
    <div class="stat-mini"><div class="v">${r.lifetime.totalSales}</div><div class="l">Lifetime Orders</div></div>
    <div class="stat-mini"><div class="v">${r.lifetime.totalUnits}</div><div class="l">Items Sold</div></div>
    <div class="stat-mini"><div class="v">${gbp(r.lifetime.grossRevenue)}</div><div class="l">Gross Revenue</div></div>
    <div class="stat-mini"><div class="v" style="color:#4ade80">${gbp(r.lifetime.netEarnings)}</div><div class="l">Net Earnings</div></div>
    <div class="stat-mini"><div class="v" style="color:#fbbf24">${gbp(r.lifetime.paidOut)}</div><div class="l">Paid Out</div></div>
  </div>
  ` : '<div class="empty-note">No sales recorded for this account yet — your first sale will populate this section.</div>'}

  <footer>
    <strong>Fresh<span class="red">Wax</span></strong> · freshwax.co.uk · For questions about this statement contact support@freshwax.co.uk
  </footer>
</div>

<!-- =================== PAGE 3 =================== -->
<div class="page">

  <div class="brand-row">
    <div class="brand-mark"><span class="fresh">FRESH</span><span class="wax">WAX</span></div>
    <div class="doc-title">
      <strong>${escape(r.artistName)}</strong>
      ${escape(r.period)}
    </div>
  </div>

  ${r.lifetime.topReleases.length > 0 ? `
  <h2>All-Time Top Releases <span class="sub">cumulative since ${escape(r.lifetime.firstSaleDate || '—')}</span></h2>
  <table class="data">
    <thead>
      <tr><th>#</th><th>Release / Track</th><th class="num">Units</th><th class="num">Gross</th><th class="num">Tracks Sold</th></tr>
    </thead>
    <tbody>
      ${r.lifetime.topReleases.map((rel, i) => {
        const total = rel.totalTracks || 0;
        const distinct = rel.distinctTracksSold || 0;
        const coverPct = total > 0 ? Math.round((distinct / total) * 100) : 0;
        const coverage = total > 0
          ? `${distinct} / ${total} <span style="color:#666; font-size:8.5pt">(${coverPct}%)</span>`
          : `${distinct}`;
        return `
      <tr class="release-row">
        <td style="color:#666; width: 30px;">${i + 1}</td>
        <td>
          <span class="release-title">${escape(rel.title)}</span>
          <span class="release-artist">${escape(rel.artist)}</span>
        </td>
        <td class="num">${rel.units}</td>
        <td class="num">${gbp(rel.gross)}</td>
        <td class="num">${coverage}</td>
      </tr>
      ${(rel.tracks || []).map(t => `
      <tr class="track-row">
        <td></td>
        <td class="track-title">${escape(t.title || '—')}</td>
        <td class="num">${t.units}</td>
        <td class="num">${gbp(t.gross)}</td>
        <td class="num"></td>
      </tr>`).join('')}
      `;
      }).join('')}
    </tbody>
  </table>` : ''}

  <h2>Orders This Period</h2>
  ${r.orders.length > 0 ? `
  <table class="data">
    <thead>
      <tr><th>Order</th><th>Date</th><th class="num">Order Total</th><th class="num">Your Items</th></tr>
    </thead>
    <tbody>
      ${r.orders.map(o => `
      <tr>
        <td style="color:#fff; font-family:monospace; font-size:9pt">${escape(o.orderNumber)}</td>
        <td style="color:#bbb">${escape(o.createdAt)}</td>
        <td class="num">${gbp(o.total)}</td>
        <td class="num"><span style="color:#aaa">${o.itemCount}</span></td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<div class="empty-note">No orders in this period.</div>'}

  <h2>Pending Payouts</h2>
  ${r.pendingPayoutRows.length > 0 ? `
  <table class="data">
    <thead>
      <tr><th>Order</th><th>Date</th><th>Method</th><th class="num">Amount</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${r.pendingPayoutRows.map(p => `
      <tr>
        <td style="color:#fff; font-family:monospace; font-size:9pt">${escape(p.orderNumber || '—')}</td>
        <td style="color:#bbb">${escape((p.createdAt || '').slice(0, 10))}</td>
        <td style="color:#aaa">${escape((p.paymentMethod || 'paypal').toUpperCase())}</td>
        <td class="num">${gbp(p.amount)}</td>
        <td><span class="pill pending">pending</span></td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<div class="empty-note">No pending payouts.</div>'}

  <h2>Recent Payouts</h2>
  ${r.recentPayouts.length > 0 ? `
  <table class="data">
    <thead>
      <tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${r.recentPayouts.map(p => `
      <tr>
        <td style="color:#fff">${escape(p.date)}</td>
        <td class="num">${gbp(p.amount)}</td>
        <td style="color:#bbb">${escape((p.method || 'paypal').toUpperCase())}</td>
        <td><span class="pill ${p.status}">${p.status}</span></td>
      </tr>`).join('')}
    </tbody>
  </table>` : '<div class="empty-note">No payouts have been issued from your account yet — pending balance will be released on the next payout date.</div>'}

  <div class="waterfall" style="margin-top: 18px;">
    <div class="waterfall-row"><span class="label">Paid out this month</span><span class="amount">${gbp(r.paidOutThisMonth)}</span></div>
    <div class="waterfall-row"><span class="label">Currently pending</span><span class="amount" style="color:#fbbf24">${gbp(r.pendingBalance)}</span></div>
    <div class="waterfall-row total"><span class="label">Net earnings this period</span><span class="amount">${gbp(r.netEarnings)}</span></div>
  </div>

  <h2>Notes</h2>
  <div style="color:#aaa; font-size: 8.5pt; line-height: 1.5;">
    Fresh Wax pays out on the 14th and 28th of every month. PayPal payouts incur the standard PayPal recipient fee (~2.9% + £0.30). Stripe Connect payouts are free but take 2–5 business days. Change your payout method at <span style="color:#ef4444">Account → Payout Settings</span>. Pending balance is released on the next payout date once funds have cleared. Refunds and chargebacks may adjust your balance.
  </div>

  <footer>
    <strong>Fresh<span class="red">Wax</span></strong> Records Ltd · freshwax.co.uk · support@freshwax.co.uk · Statement period ${escape(r.periodStart)} to ${escape(r.periodEnd)} · All figures in GBP
  </footer>
</div>

</body>
</html>`;
}

// ---- Render ---------------------------------------------------------
(async () => {
  const html = buildHtml(REPORT);
  const outDir = 'C:/Users/Owner/Documents';
  const filename = `FreshWax-Monthly-Statement-${REPORT.artistName.replace(/[^a-zA-Z0-9]+/g, '-')}-${REPORT.period.replace(' ', '-')}.pdf`;
  const outPath = path.join(outDir, filename);

  const tmpHtml = path.join(__dirname, 'monthly-report.preview.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + tmpHtml.replace(/\\/g, '/'));
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
    preferCSSPageSize: true,
  });
  await browser.close();

  console.log(`PDF saved: ${outPath}`);
  console.log(`Preview HTML kept at: ${tmpHtml}`);
})().catch(e => { console.error(e); process.exit(1); });
