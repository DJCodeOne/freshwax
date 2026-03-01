// src/lib/weekly-digest-template.ts
// Email HTML builder for weekly digest — "This Week on FreshWax"

import { emailWrapper, esc, ctaButton } from './email-wrapper';
import { SITE_URL } from './constants';
import { formatPrice } from './format-utils';

// ============================================
// TYPES
// ============================================

export interface DigestRelease {
  id: string;
  title: string;
  artistName: string;
  imageUrl?: string;
  price?: number;
  score: number;
}

export interface DigestMix {
  id: string;
  title: string;
  djName: string;
  imageUrl?: string;
  score: number;
}

export interface DigestSupport {
  djName: string;
  releaseTitle: string;
  artistName: string;
  releaseId: string;
}

export interface WeeklyDigestData {
  topReleases: DigestRelease[];
  topMixes: DigestMix[];
  djSupportHighlights: DigestSupport[];
  weekStart: string;
  weekEnd: string;
}

// ============================================
// TEMPLATE
// ============================================

function releaseRow(release: DigestRelease, rank: number): string {
  const imageHtml = release.imageUrl
    ? `<img src="${esc(release.imageUrl)}" alt="${esc(release.title)}" width="48" height="48" style="border-radius:6px;object-fit:cover;vertical-align:middle;" />`
    : `<div style="width:48px;height:48px;border-radius:6px;background:#262626;display:inline-block;vertical-align:middle;"></div>`;

  const priceHtml = release.price != null
    ? `<span style="color:#dc2626;font-weight:700;">${esc(formatPrice(release.price))}</span>`
    : '';

  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #262626;vertical-align:middle;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="30" style="color:#737373;font-size:14px;font-weight:700;vertical-align:middle;">${rank}.</td>
            <td width="56" style="vertical-align:middle;">${imageHtml}</td>
            <td style="padding-left:12px;vertical-align:middle;">
              <a href="${SITE_URL}/item/${esc(release.id)}/" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;" class="text-primary">${esc(release.title)}</a>
              <br/>
              <span style="color:#a3a3a3;font-size:13px;" class="text-secondary">${esc(release.artistName)}</span>
            </td>
            <td width="60" align="right" style="vertical-align:middle;">${priceHtml}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function mixRow(mix: DigestMix, rank: number): string {
  const imageHtml = mix.imageUrl
    ? `<img src="${esc(mix.imageUrl)}" alt="${esc(mix.title)}" width="48" height="48" style="border-radius:6px;object-fit:cover;vertical-align:middle;" />`
    : `<div style="width:48px;height:48px;border-radius:6px;background:#262626;display:inline-block;vertical-align:middle;"></div>`;

  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #262626;vertical-align:middle;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="30" style="color:#737373;font-size:14px;font-weight:700;vertical-align:middle;">${rank}.</td>
            <td width="56" style="vertical-align:middle;">${imageHtml}</td>
            <td style="padding-left:12px;vertical-align:middle;">
              <a href="${SITE_URL}/dj-mix/${esc(mix.id)}/" style="color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;" class="text-primary">${esc(mix.title)}</a>
              <br/>
              <span style="color:#a3a3a3;font-size:13px;" class="text-secondary">by ${esc(mix.djName)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

export function buildWeeklyDigestHtml(data: WeeklyDigestData): string {
  // Top releases section
  let releasesHtml = '';
  if (data.topReleases.length > 0) {
    const rows = data.topReleases.map((r, i) => releaseRow(r, i + 1)).join('');
    releasesHtml = `
      <h2 style="color:#ffffff;font-size:20px;font-weight:700;margin:0 0 16px;" class="text-primary">Top Releases</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows}
      </table>
      ${ctaButton('Browse All Releases', `${SITE_URL}/releases/`)}
    `;
  }

  // Top mixes section
  let mixesHtml = '';
  if (data.topMixes.length > 0) {
    const rows = data.topMixes.map((m, i) => mixRow(m, i + 1)).join('');
    mixesHtml = `
      <h2 style="color:#ffffff;font-size:20px;font-weight:700;margin:24px 0 16px;" class="text-primary">Top DJ Mixes</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows}
      </table>
      ${ctaButton('Browse All Mixes', `${SITE_URL}/dj-mixes/`)}
    `;
  }

  // DJ support highlights
  let supportHtml = '';
  if (data.djSupportHighlights.length > 0) {
    const items = data.djSupportHighlights
      .slice(0, 5)
      .map(s => `
        <li style="color:#a3a3a3;font-size:14px;margin-bottom:8px;line-height:1.5;" class="text-secondary">
          <span style="color:#ffffff;font-weight:600;" class="text-primary">${esc(s.djName)}</span> played
          <a href="${SITE_URL}/item/${esc(s.releaseId)}/" style="color:#dc2626;text-decoration:none;font-weight:600;">${esc(s.releaseTitle)}</a>
          by ${esc(s.artistName)}
        </li>`)
      .join('');

    supportHtml = `
      <h2 style="color:#ffffff;font-size:20px;font-weight:700;margin:24px 0 16px;" class="text-primary">DJ Support</h2>
      <ul style="padding-left:20px;margin:0;">${items}</ul>
    `;
  }

  // Combine
  const content = `
    <p style="color:#a3a3a3;font-size:14px;margin:0 0 24px;line-height:1.6;" class="text-secondary">
      Here's what happened on FreshWax this week (${esc(data.weekStart)} – ${esc(data.weekEnd)}).
    </p>
    ${releasesHtml}
    ${mixesHtml}
    ${supportHtml}
  `;

  return emailWrapper(content, {
    title: 'This Week on FreshWax',
    headerText: 'This Week on FreshWax',
    footerExtra: `<p style="color:#525252;font-size:12px;margin:0;text-align:center;">
      <a href="${SITE_URL}/account/dashboard/" style="color:#737373;text-decoration:underline;">Manage email preferences</a>
       &middot;
      <a href="${SITE_URL}/unsubscribe/" style="color:#737373;text-decoration:underline;">Unsubscribe</a>
    </p>`,
  });
}
