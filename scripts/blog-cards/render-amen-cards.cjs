// Renders the Amen break blog images from amen-card.html via the repo's Playwright.
const { createRequire } = require('module');
const req = createRequire('C:/Users/Owner/freshwax/package.json');
let chromium;
try { ({ chromium } = req('playwright')); }
catch { ({ chromium } = req('@playwright/test')); }
const sharp = req('sharp');
const path = require('path');

const HTML = 'file:///' + path.join(__dirname, 'amen-card.html').replace(/\\/g, '/');
const OUT = 'C:/Users/Owner/freshwax/public';

(async () => {
  const browser = await chromium.launch();
  try {
    // OG card 1200x630 straight to JPG
    let page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto(HTML);
    await page.waitForFunction('window.__ready === true');
    await page.screenshot({ path: `${OUT}/blog-amen-break-og.jpg`, type: 'jpeg', quality: 88 });
    await page.close();

    // Featured 1000x662 -> webp via sharp
    page = await browser.newPage({ viewport: { width: 1000, height: 662 } });
    await page.goto(HTML);
    await page.waitForFunction('window.__ready === true');
    const png = await page.screenshot({ type: 'png' });
    await sharp(png).webp({ quality: 84 }).toFile(`${OUT}/blog-amen-break.webp`);
    await page.close();

    console.log('done');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
