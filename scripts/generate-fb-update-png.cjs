// Render the May 2026 Fresh Wax monthly update as a Facebook/IG-ready
// PNG (1080×1620, IG portrait — also looks good on FB feed).
// Brand styling matches the monthly statement PDF generator: black bg,
// red WAX accent, dark surfaces.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const WIDTH = 1080;
// Taller canvas to accommodate larger fonts. FB feeds happily display
// long portraits with tap-to-expand; IG story height limit is 1920 but
// FB has no practical limit.
const HEIGHT = 2160;
const SAFE_TOP = 140;
const SAFE_BOTTOM = 140;

function escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Fresh Wax — May 2026 Update</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    /* Facebook re-encodes uploaded images to JPEG ~80%, which softens
       thin/light text. Set a medium base weight + crisp antialiasing
       so body copy survives the recompression with readable edges. */
    font-weight: 500;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    color: #f0f0f0;
    /* Generous top/bottom padding pushes content into the safe zone
       so Facebook / IG feed crops don't lop off the brand mark or
       the "Stay Locked" footer. */
    padding: ${SAFE_TOP}px 72px ${SAFE_BOTTOM}px;
    position: relative;
    overflow: hidden;
  }

  /* Subtle bleed pattern in the safe-zone padding so it doesn't look
     empty if the crop falls inside the visible image. Just a faint
     red glow corner. */
  .bleed-mark {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    color: #2a2a2a;
    font-size: 14px;
    letter-spacing: 5px;
    text-transform: uppercase;
    font-weight: 600;
  }
  .bleed-top { top: 50px; }
  .bleed-bottom { bottom: 50px; }

  /* Subtle vignette — faint red glow corners to echo the brand accent */
  body::before {
    content: '';
    position: absolute;
    top: -200px; right: -200px;
    width: 600px; height: 600px;
    background: radial-gradient(circle, rgba(239,68,68,0.15) 0%, transparent 70%);
    pointer-events: none;
  }
  body::after {
    content: '';
    position: absolute;
    bottom: -200px; left: -200px;
    width: 500px; height: 500px;
    background: radial-gradient(circle, rgba(239,68,68,0.07) 0%, transparent 70%);
    pointer-events: none;
  }

  /* Brand mark — centered, stacked */
  .brand-row {
    text-align: center;
    border-bottom: 2px solid #2a2a2a;
    padding-bottom: 24px;
    margin-bottom: 32px;
    position: relative;
    z-index: 1;
  }
  .brand-mark {
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-size: 110px;
    letter-spacing: 2px;
    line-height: 1;
    margin-bottom: 14px;
  }
  .brand-mark .fresh { color: #fff; }
  .brand-mark .wax   { color: #ef4444; }
  .doc-title {
    color: #888;
    font-size: 18px;
    text-transform: uppercase;
    letter-spacing: 5px;
  }
  .doc-title strong {
    color: #fff;
    font-size: 22px;
    margin-right: 16px;
    letter-spacing: 4px;
  }

  /* Big headline — centered, all white (WAX brand mark is the only red) */
  .headline {
    font-family: 'Impact', 'Arial Black', sans-serif;
    color: #fff;
    font-size: 72px;
    line-height: 1;
    letter-spacing: 2px;
    text-align: center;
    margin-bottom: 14px;
    position: relative;
    z-index: 1;
  }
  .sub-headline {
    color: #999;
    font-size: 20px;
    letter-spacing: 3px;
    text-transform: uppercase;
    text-align: center;
    margin-bottom: 38px;
    position: relative;
    z-index: 1;
  }

  /* Sections — center the divider, left-align body for readability */
  .section {
    margin-bottom: 30px;
    position: relative;
    z-index: 1;
    text-align: center;
  }
  .section-header {
    color: #ef4444;
    font-size: 26px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 4px;
    margin-bottom: 14px;
    padding-bottom: 8px;
    display: inline-flex;
    align-items: center;
    gap: 18px;
    border-bottom: 1px solid #2a2a2a;
    padding-left: 28px;
    padding-right: 28px;
  }
  .section-header::before,
  .section-header::after {
    content: '';
    width: 10px; height: 10px;
    background: #ef4444;
    border-radius: 50%;
    box-shadow: 0 0 14px rgba(239,68,68,0.7);
  }
  .section-body {
    text-align: left;
    max-width: 920px;
    margin: 0 auto;
  }
  .section p {
    color: #f0f0f0;
    font-size: 24px;
    font-weight: 500;
    line-height: 1.55;
    margin-bottom: 14px;
  }
  .section p strong { color: #fff; font-weight: 700; }
  .section p .accent { color: #fff; font-weight: 700; text-decoration: underline; text-decoration-color: #666; text-underline-offset: 4px; }

  ul.bullets {
    list-style: none;
    margin: 10px 0 0 0;
  }
  ul.bullets li {
    color: #f0f0f0;
    font-size: 24px;
    font-weight: 500;
    line-height: 1.5;
    padding-left: 28px;
    position: relative;
    margin-bottom: 12px;
  }
  ul.bullets li::before {
    content: '';
    position: absolute;
    left: 0; top: 14px;
    width: 9px; height: 9px;
    background: #fff;
    border-radius: 50%;
    opacity: 0.75;
  }

  /* Footer — centered, sits above the bottom safe-zone bleed */
  footer {
    position: absolute;
    bottom: ${SAFE_BOTTOM + 20}px;
    left: 72px;
    right: 72px;
    border-top: 1px solid #2a2a2a;
    padding-top: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: #888;
    font-size: 15px;
    letter-spacing: 1px;
    z-index: 1;
  }
  footer .tag {
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 5px;
    font-weight: 700;
    font-size: 18px;
  }
  footer .url {
    color: #fff;
    font-weight: 600;
    letter-spacing: 4px;
    font-size: 24px;
  }
  footer .url .wax-red { color: #ef4444; }
</style>
</head>
<body>

  <div class="bleed-mark bleed-top">—  FRESH WAX  —</div>

  <div class="brand-row">
    <div class="brand-mark"><span class="fresh">FRESH</span><span class="wax">WAX</span></div>
    <div class="doc-title">
      <strong>Monthly Update</strong>May 2026
    </div>
  </div>

  <div class="headline">WHAT'S FRESHLY CUT</div>
  <div class="sub-headline">busy month behind the scenes — here's what's new</div>

  <div class="section">
    <div class="section-header">For Everyone</div>
    <div class="section-body">
      <p>Sign-in is smoother. A few things that used to trip people up:</p>
      <ul class="bullets">
        <li>Verify your email on your phone, then log in on your desktop — <strong>finally works without sending you back to the verification screen</strong>.</li>
        <li>After I ship an update to the site, you'll no longer get stuck in a "you're signed in but please sign in" loop. The site picks up new versions and <strong>refreshes itself in the background</strong>.</li>
        <li>More accurate fee totals across all the admin and dashboard views — <strong>what you see is what was actually charged</strong>.</li>
      </ul>
    </div>
  </div>

  <div class="section">
    <div class="section-header">For DJs</div>
    <div class="section-body">
      <p>Stream keys are now <strong>permanent to your account</strong>. Set them up in OBS once, and they stay valid every time you go live — no more updating settings each session.</p>
      <p>If you're broadcasting and nobody's booked after you, the slot now <strong>extends automatically</strong> so you can keep the set running past the hour mark. Listeners stay connected, no cut-off.</p>
      <p>DJ Lobby video preview is back in working order, and I've ironed out a handful of smaller livestream wrinkles.</p>
    </div>
  </div>

  <div class="section">
    <div class="section-header">For Artists &amp; Labels</div>
    <div class="section-body">
      <p>I've completely overhauled how payouts are tracked. <strong>Multi-payee releases</strong> with split ownership (50/50 EPs and similar arrangements) are now handled automatically — your share is calculated and credited correctly, every time.</p>
      <p>I've also gone back through every historical sale and <strong>reconciled the books</strong> so everyone is paid the exact correct amount, with fees from PayPal and Fresh Wax accurately reflected in your dashboard.</p>
    </div>
  </div>

  <div class="section">
    <div class="section-header">Coming Up</div>
    <div class="section-body">
      <p>More livestream features, deeper artist analytics, scheduled DJ residencies. Keep an eye out.</p>
      <p>If you hit anything weird, drop me a message. Always listening.</p>
    </div>
  </div>

  <footer>
    <span class="tag">Stay Locked</span>
    <span class="url">fresh<span class="wax-red">wax</span>.co.uk</span>
  </footer>

  <div class="bleed-mark bleed-bottom">—  FRESH WAX  —</div>

</body>
</html>`;

(async () => {
  const tmpHtml = path.join(__dirname, 'fb-update.preview.html');
  fs.writeFileSync(tmpHtml, html);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    // 3× pixel density. Facebook always re-encodes uploaded images to
    // JPEG ~80% — feeding it a higher-resolution source means the
    // downscaling step preserves text edges much better than rendering
    // at target size. Output PNG = 3240 × 6480, FB will downscale to
    // 1080 wide, and the resulting JPEG stays sharp.
    deviceScaleFactor: 3,
  });
  await page.goto('file://' + tmpHtml.replace(/\\/g, '/'));

  const outPath = 'C:/Users/Owner/Documents/FreshWax-Monthly-Update-May-2026.png';
  await page.screenshot({ path: outPath, fullPage: false, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  await browser.close();

  console.log(`PNG saved: ${outPath}`);
  console.log(`(${WIDTH}×${HEIGHT} logical, ${WIDTH * 3}×${HEIGHT * 3} actual pixels — 3× density)`);
})().catch(e => { console.error(e); process.exit(1); });
