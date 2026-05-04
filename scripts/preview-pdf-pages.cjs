// Render the preview HTML to PNG screenshots so we can eyeball each page.
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const tmpHtml = path.join(__dirname, 'monthly-report.preview.html');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } }); // A4 @ 96dpi
  await page.goto('file://' + tmpHtml.replace(/\\/g, '/'));
  await page.emulateMedia({ media: 'print' });
  // Snapshot the whole page in one tall image
  const outPath = path.join(__dirname, 'monthly-report.preview.png');
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();
  console.log('Preview saved:', outPath);
})().catch(e => { console.error(e); process.exit(1); });
