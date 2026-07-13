// src/pages/feeds/google-shopping.xml.ts
// Google Merchant Center product feed (RSS 2.0 + g: namespace).
//
// PHYSICAL GOODS ONLY: vinyl releases + merch. Digital downloads are
// deliberately excluded — Google Shopping policy prohibits digitally
// downloadable content in product listings, and including them risks
// Merchant Center account suspension.
//
// Registered in Merchant Center (account 5823955565, "Fresh Wax") as a
// scheduled file fetch. Served from /feeds/ (NOT /api/ — robots.txt blocks
// /api/ and Google's feed fetcher respects it).

import { getLiveReleases, getLiveMerch } from '../../lib/firebase-rest';
import { SITE_URL } from '../../lib/constants';

export const prerender = false;

function str(val: unknown): string {
  if (val == null) return '';
  return typeof val === 'string' ? val : String(val);
}

function escapeXml(val: unknown): string {
  const s = str(val);
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isValidImageUrl(url: unknown): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('place-holder') || url.includes('placeholder')) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Single-line, length-capped description (Google limit 5000; keep it tidy) */
function cleanDescription(val: unknown, fallback: string): string {
  const s = str(val).replace(/\s+/g, ' ').trim() || fallback;
  return s.length > 4900 ? s.slice(0, 4900) + '…' : s;
}

function money(val: unknown): string | null {
  const n = typeof val === 'number' ? val : parseFloat(str(val));
  if (!isFinite(n) || n <= 0) return null;
  return `${n.toFixed(2)} GBP`;
}

interface FeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImages?: string[];
  price: string;          // "12.00 GBP"
  salePrice?: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder';
  availabilityDate?: string; // ISO8601, required for preorder
  brand: string;
  productType: string;
  googleProductCategory?: string;
}

function renderItem(it: FeedItem): string {
  let xml = `    <item>
      <g:id>${escapeXml(it.id)}</g:id>
      <g:title>${escapeXml(it.title.slice(0, 150))}</g:title>
      <g:description>${escapeXml(it.description)}</g:description>
      <g:link>${escapeXml(it.link)}</g:link>
      <g:image_link>${escapeXml(it.imageLink)}</g:image_link>`;
  for (const img of it.additionalImages || []) {
    xml += `
      <g:additional_image_link>${escapeXml(img)}</g:additional_image_link>`;
  }
  xml += `
      <g:price>${escapeXml(it.price)}</g:price>`;
  if (it.salePrice) {
    xml += `
      <g:sale_price>${escapeXml(it.salePrice)}</g:sale_price>`;
  }
  xml += `
      <g:availability>${it.availability}</g:availability>`;
  if (it.availability === 'preorder' && it.availabilityDate) {
    xml += `
      <g:availability_date>${escapeXml(it.availabilityDate)}</g:availability_date>`;
  }
  xml += `
      <g:condition>new</g:condition>
      <g:brand>${escapeXml(it.brand)}</g:brand>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${escapeXml(it.productType)}</g:product_type>`;
  if (it.googleProductCategory) {
    xml += `
      <g:google_product_category>${escapeXml(it.googleProductCategory)}</g:google_product_category>`;
  }
  // Flat UK shipping, matching the OfferShippingDetails schema on product pages
  xml += `
      <g:shipping>
        <g:country>GB</g:country>
        <g:service>Standard</g:service>
        <g:price>3.50 GBP</g:price>
      </g:shipping>
    </item>
`;
  return xml;
}

export const GET = async () => {
  let releases: Record<string, unknown>[] = [];
  let merchItems: Record<string, unknown>[] = [];

  const [releasesResult, merchResult] = await Promise.allSettled([
    getLiveReleases(500),
    getLiveMerch(500),
  ]);
  if (releasesResult.status === 'fulfilled') releases = releasesResult.value;
  if (merchResult.status === 'fulfilled') merchItems = merchResult.value;

  const items: FeedItem[] = [];
  const now = Date.now();

  // ----- Vinyl releases (physical only — digital-only releases are skipped) -----
  for (const r of releases) {
    if (r.vinylRelease !== true) continue;
    const price = money(r.vinylPrice);
    const image = r.coverArtUrl || r.artworkUrl;
    if (!price || !isValidImageUrl(image)) continue;

    const artist = str(r.artistName || r.artist);
    const name = str(r.releaseName || r.title || 'Release');
    const vinylStock = typeof r.vinylStock === 'number' ? r.vinylStock : parseInt(str(r.vinylStock) || '0');
    const recordCount = parseInt(str(r.vinylRecordCount) || '0');
    const inStock = vinylStock > 0 || recordCount > 0;
    const releaseTs = r.releaseDate ? new Date(str(r.releaseDate)).getTime() : 0;
    const isPreOrder = isFinite(releaseTs) && releaseTs > now;

    items.push({
      id: `vinyl_${str(r.id)}`,
      title: `${artist ? artist + ' - ' : ''}${name} (Vinyl)`,
      description: cleanDescription(
        r.description,
        `${name}${artist ? ' by ' + artist : ''} — jungle & drum and bass vinyl on ${str(r.label) || 'Fresh Wax'}. Includes digital download.`
      ),
      link: `${SITE_URL}/item/${str(r.id)}/`,
      imageLink: str(image),
      price,
      availability: isPreOrder ? 'preorder' : (inStock ? 'in_stock' : 'out_of_stock'),
      ...(isPreOrder && { availabilityDate: new Date(releaseTs).toISOString() }),
      brand: str(r.label) || artist || 'Fresh Wax',
      productType: 'Music > Vinyl Records',
      googleProductCategory: 'Media > Music & Sound Recordings > Records & LPs',
    });
  }

  // ----- Merch (physical) -----
  for (const m of merchItems) {
    const retail = money(m.retailPrice || m.price);
    const images = (m.images as Array<Record<string, unknown> | string> | undefined) || [];
    const imageUrls = images
      .map((img) => (typeof img === 'string' ? img : str((img as Record<string, unknown>).url)))
      .filter((u) => isValidImageUrl(u));
    const primary = str(m.primaryImage) && isValidImageUrl(m.primaryImage) ? str(m.primaryImage) : imageUrls[0];
    if (!retail || !primary) continue;

    const name = str(m.name || m.title || 'Merchandise');
    const onSale = m.onSale === true && money(m.salePrice);
    const stock = m.stock;
    const inStock = stock === undefined || stock === null || (typeof stock === 'number' && stock > 0);

    items.push({
      id: `merch_${str(m.id)}`,
      title: name,
      description: cleanDescription(m.description, `Official Fresh Wax merchandise — ${name}.`),
      link: `${SITE_URL}/merch/${str(m.id)}/`,
      imageLink: primary,
      additionalImages: imageUrls.filter((u) => u !== primary).slice(0, 10),
      price: retail,
      ...(onSale && { salePrice: money(m.salePrice)! }),
      availability: inStock ? 'in_stock' : 'out_of_stock',
      brand: str(m.brand) || 'Fresh Wax',
      productType: `Merch > ${str(m.category) || 'General'}`,
    });
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Fresh Wax</title>
    <link>${SITE_URL}</link>
    <description>Independent UK jungle and drum &amp; bass record store — vinyl and official merchandise.</description>
`;
  for (const it of items) xml += renderItem(it);
  xml += `  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      'X-Robots-Tag': 'noindex',
    },
  });
};
