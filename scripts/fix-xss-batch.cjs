// Batch fix: Add escapeHtml to files with innerHTML XSS
const fs = require('fs');
const path = require('path');

const escapeHtmlFunc = `
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
`;

// Files that need escapeHtml added (only if they don't already have it)
const files = [
  'src/pages/live.astro',
  'src/pages/dj-mix/[id].astro',
  'src/pages/item/[id].astro',
  'src/pages/merch.astro',
  'src/pages/dj-mixes.astro',
  'src/pages/schedule.astro',
  'src/pages/crates.astro',
  'src/pages/crates/[id].astro',
  'src/pages/dj-lobby/book.astro',
  'src/pages/admin/users.astro',
  'src/pages/admin/approvals.astro',
  'src/pages/admin/artists/manage.astro',
  'src/pages/admin/giftcards.astro',
  'src/pages/admin/vinyl/orders.astro',
  'src/pages/pro/merch/orders.astro',
  'src/pages/pro/merch/stock.astro',
  'src/pages/pro/merch/analytics.astro',
  'src/pages/pro/merch/index.astro',
  'src/pages/artist/vinyl/orders.astro',
  'src/pages/artist/vinyl/index.astro',
  'src/components/LiveChat.astro',
  'src/components/DjBookingsManager.astro',
];

let fixedCount = 0;

for (const filePath of files) {
  const fullPath = path.join(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    console.log('SKIP (not found):', filePath);
    continue;
  }

  let content = fs.readFileSync(fullPath, 'utf8');

  // Check if already has escapeHtml function
  if (content.includes('function escapeHtml(')) {
    console.log('SKIP (already has escapeHtml):', filePath);
    continue;
  }

  // Find the first <script tag in the HTML section (after closing ---)
  // We need to inject escapeHtml into the client-side script

  // Strategy: Find first occurrence of 'innerHTML' and add escapeHtml function
  // before the function/block that contains it

  // Find the script section containing innerHTML
  const innerHtmlIdx = content.indexOf('.innerHTML');
  if (innerHtmlIdx === -1) {
    console.log('SKIP (no innerHTML):', filePath);
    continue;
  }

  // Find the nearest <script preceding the innerHTML usage
  let searchFrom = innerHtmlIdx;
  let scriptStart = -1;
  while (searchFrom > 0) {
    const idx = content.lastIndexOf('<script', searchFrom);
    if (idx !== -1) {
      scriptStart = idx;
      break;
    }
    searchFrom -= 1000;
  }

  if (scriptStart === -1) {
    console.log('SKIP (no script tag found):', filePath);
    continue;
  }

  // Find the end of the opening script tag
  const scriptTagEnd = content.indexOf('>', scriptStart) + 1;

  // Insert escapeHtml function right after the script tag opening
  content = content.slice(0, scriptTagEnd) + '\n' + escapeHtmlFunc + content.slice(scriptTagEnd);

  fs.writeFileSync(fullPath, content);
  console.log('ADDED escapeHtml to:', filePath);
  fixedCount++;
}

console.log('\nDone! Added escapeHtml to', fixedCount, 'files');
console.log('NOTE: You still need to manually wrap user data with escapeHtml() in innerHTML assignments');
