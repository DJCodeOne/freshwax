// Generate the landscape featured image for the May 2026 monthly update
// blog post. Brand-styled, 1200×630 (OG / blog hero ratio).
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const WIDTH = 1200;
const HEIGHT = 630;

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    color: #f0f0f0;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    padding: 60px 80px;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
  }
  body::before {
    content: '';
    position: absolute;
    top: -250px; right: -250px;
    width: 700px; height: 700px;
    background: radial-gradient(circle, rgba(239,68,68,0.2) 0%, transparent 70%);
  }
  body::after {
    content: '';
    position: absolute;
    bottom: -200px; left: -200px;
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(239,68,68,0.1) 0%, transparent 70%);
  }
  .brand {
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: 96px;
    line-height: 1;
    letter-spacing: 2px;
    margin-bottom: 18px;
    position: relative;
    z-index: 1;
  }
  .brand .fresh { color: #fff; }
  .brand .wax { color: #ef4444; }
  .label {
    color: #888;
    font-size: 18px;
    text-transform: uppercase;
    letter-spacing: 6px;
    margin-bottom: 30px;
    position: relative;
    z-index: 1;
  }
  .label strong { color: #fff; margin-right: 14px; letter-spacing: 5px; }
  .divider {
    width: 120px;
    height: 2px;
    background: #ef4444;
    margin: 0 auto 30px;
    position: relative;
    z-index: 1;
    box-shadow: 0 0 10px rgba(239,68,68,0.5);
  }
  .headline {
    font-family: 'Impact', 'Arial Black', sans-serif;
    color: #fff;
    font-size: 64px;
    line-height: 1;
    letter-spacing: 2px;
    position: relative;
    z-index: 1;
    margin-bottom: 12px;
  }
  .sub {
    color: #aaa;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: 2px;
    text-transform: uppercase;
    position: relative;
    z-index: 1;
  }
</style></head>
<body>
  <div class="brand"><span class="fresh">FRESH</span><span class="wax">WAX</span></div>
  <div class="label"><strong>Monthly Update</strong>May 2026</div>
  <div class="divider"></div>
  <div class="headline">WHAT'S FRESHLY CUT</div>
  <div class="sub">A look at what's new this month</div>
</body></html>`;

(async () => {
  const tmpHtml = path.join(__dirname, 'blog-featured.preview.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto('file://' + tmpHtml.replace(/\\/g, '/'));

  const outPath = path.resolve(__dirname, '..', 'public', 'blog-may-2026-update.jpg');
  await page.screenshot({ path: outPath, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  await browser.close();

  console.log(`Featured image saved: ${outPath}`);
  console.log(`(${WIDTH}×${HEIGHT}, 2× density, JPEG @92%)`);
})().catch(e => { console.error(e); process.exit(1); });
