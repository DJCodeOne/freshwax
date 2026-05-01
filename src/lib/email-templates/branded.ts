// src/lib/email-templates/branded.ts
// Shared on-brand email template — white FRESH WAX wordmark header card +
// red announcement strip + dark content panel with 2px red outline + footer.
//
// Use this for every notification, approval, or sale email Fresh Wax sends
// so the user sees a consistent layout. Caller supplies the strip text and
// the inner content HTML — the wrapper handles header, footer, brand styling.
//
// Example:
//   import { brandedEmail } from '../../lib/email-templates/branded';
//   import { esc } from '../email-wrapper';
//
//   const html = brandedEmail({
//     stripHeadline: "🎵 YOU'RE APPROVED!",
//     body: `
//       <p style="font-size:18px;line-height:1.5;margin:0 0 12px;color:#fff;font-weight:700;">Ez ${esc(name)} 👋</p>
//       <p style="font-size:15px;line-height:1.5;margin:0 0 24px;color:#d1d5db;">…body copy…</p>
//       ${brandedCta('Go to DJ Lobby', SITE_URL + '/account/dj-lobby/')}
//     `,
//   });

import { SITE_URL } from '../constants';

export interface BrandedEmailOptions {
  /** Short red-strip headline (e.g. "🎵 YOU'RE APPROVED!", "🎵 NEW SALE!") */
  stripHeadline: string;
  /** Optional small subtitle under the strip headline (order number, etc.) */
  stripSubtitle?: string;
  /** Inner content HTML — greeting, paragraphs, lists, CTAs */
  body: string;
}

export function brandedEmail(opts: BrandedEmailOptions): string {
  const { stripHeadline, stripSubtitle, body } = opts;
  const subtitleHtml = stripSubtitle
    ? `<div style="font-size:13px;color:rgba(255,255,255,0.9);margin-top:4px;">${stripSubtitle}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#000;"><tr><td align="center" style="padding:40px 20px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
      <tr><td style="background:#fff;padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;border:2px solid #dc2626;border-bottom:none;">
        <div style="font-size:32px;font-weight:900;letter-spacing:2px;line-height:1;"><span style="color:#000;">FRESH</span> <span style="color:#dc2626;">WAX</span></div>
        <div style="font-size:11px;color:#666;margin-top:6px;letter-spacing:3px;font-weight:600;">JUNGLE &bull; DRUM AND BASS</div>
      </td></tr>
      <tr><td style="background:#dc2626;padding:18px 24px;text-align:center;border-left:2px solid #dc2626;border-right:2px solid #dc2626;">
        <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:0.5px;line-height:1.3;">${stripHeadline}</div>${subtitleHtml}
      </td></tr>
      <tr><td style="background:#111;padding:32px 28px;border-left:2px solid #dc2626;border-right:2px solid #dc2626;border-bottom:2px solid #dc2626;border-radius:0 0 12px 12px;">
        ${body}
      </td></tr>
      <tr><td align="center" style="padding:22px 0 0;">
        <div style="color:#9ca3af;font-size:12px;">Automated notification from FreshWax</div>
        <div style="margin-top:6px;"><a href="${SITE_URL}" style="font-size:12px;text-decoration:none;font-weight:600;"><span style="color:#fff;">fresh</span><span style="color:#dc2626;">wax</span><span style="color:#fff;">.co.uk</span></a></div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

/**
 * Standard red CTA button (uppercase, slightly tracked) — designed to live
 * inside a brandedEmail body. Renders the same on Outlook (table-based)
 * and modern email clients.
 */
export function brandedCta(text: string, href: string): string {
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding:6px 0 22px;">
    <a href="${href}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:0.5px;text-transform:uppercase;">${text}</a>
  </td></tr></table>`;
}
