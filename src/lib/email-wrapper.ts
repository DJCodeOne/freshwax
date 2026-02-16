// src/lib/email-wrapper.ts
// Shared email wrapper for consistent branding, mobile responsiveness, and dark mode support
// All email templates should use emailWrapper() for consistent header/footer/styling

import { SITE_URL } from './constants';

/** Escape user-supplied data for safe HTML embedding */
export function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Dark-mode-aware email wrapper with consistent branding.
 *
 * @param content - Inner HTML content (goes between header and footer)
 * @param options - Configuration for the header gradient, footer text, etc.
 *
 * Design notes:
 *  - 600px max-width container with fluid inner content
 *  - Inline CSS for maximum email client compatibility
 *  - <style> block for dark mode (Gmail, Apple Mail, Outlook iOS) and mobile
 *  - Table-based layout for Outlook compatibility
 *  - All text meets WCAG AA contrast requirements
 *  - CTA buttons have 48px+ touch targets
 */
export interface EmailWrapperOptions {
  /** Title for <title> tag (not always visible) */
  title?: string;
  /** Header text (h1 inside gradient bar) */
  headerText?: string;
  /** CSS gradient for header bar. Default: red gradient */
  headerGradient?: string;
  /** Override footer branding. Default: FreshWax - Underground Music Platform */
  footerBrand?: string;
  /** Extra footer line (e.g. unsubscribe link) */
  footerExtra?: string;
  /** Hide the standard header entirely (for light-theme or custom header emails) */
  hideHeader?: boolean;
  /** Use light theme instead of dark (for order confirmations, gift cards) */
  lightTheme?: boolean;
}

const DEFAULT_HEADER_GRADIENT = 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)';

export function emailWrapper(content: string, options: EmailWrapperOptions = {}): string {
  const {
    title = 'Fresh Wax',
    headerText,
    headerGradient = DEFAULT_HEADER_GRADIENT,
    footerBrand,
    footerExtra = '',
    hideHeader = false,
    lightTheme = false,
  } = options;

  // Colour palette — dark theme (default)
  const bgOuter = lightTheme ? '#f3f4f6' : '#0a0a0a';
  const bgCard = lightTheme ? '#ffffff' : '#141414';
  const bgFooter = lightTheme ? '#f3f4f6' : '#0a0a0a';
  const borderColor = lightTheme ? '#e5e7eb' : '#262626';
  const textPrimary = lightTheme ? '#111111' : '#ffffff';
  const textSecondary = lightTheme ? '#6b7280' : '#a3a3a3';
  const textMuted = lightTheme ? '#9ca3af' : '#737373';
  const footerText = lightTheme ? '#6b7280' : '#525252';
  const linkColor = lightTheme ? '#111111' : '#ffffff';

  const brandHtml = footerBrand
    ? `<span style="color: ${textPrimary};">${esc(footerBrand)}</span>`
    : `<span style="color: ${textPrimary};">Fresh</span><span style="color: #dc2626;">Wax</span><span style="color: ${textSecondary};"> - Underground Music Platform</span>`;

  const headerRow = hideHeader ? '' : `
          <!-- Header -->
          <tr>
            <td style="background: ${headerGradient}; padding: 40px 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; line-height: 1.3;">
                ${headerText || 'Fresh Wax'}
              </h1>
            </td>
          </tr>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(title)}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }

    /* Mobile */
    @media only screen and (max-width: 640px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .email-container td { padding-left: 20px !important; padding-right: 20px !important; }
      .email-header td { padding: 28px 20px 20px !important; }
      .email-header h1 { font-size: 22px !important; }
      .email-content { padding: 28px 20px !important; }
      .email-footer td { padding: 20px !important; }
      .cta-button { padding: 14px 28px !important; font-size: 15px !important; }
      .hide-on-mobile { display: none !important; }
    }

    /* Dark mode — Gmail, Apple Mail, Outlook iOS */
    @media (prefers-color-scheme: dark) {
      body, .email-bg { background-color: #0a0a0a !important; }
      .email-card { background-color: #141414 !important; }
      .email-footer-bg { background-color: #0a0a0a !important; }
      .text-primary { color: #ffffff !important; }
      .text-secondary { color: #a3a3a3 !important; }
      .text-muted { color: #737373 !important; }
      .detail-box { background-color: #1f1f1f !important; }
      .border-subtle { border-color: #262626 !important; }
      /* Light-theme overrides for dark mode */
      .light-card { background-color: #141414 !important; }
      .light-bg { background-color: #0a0a0a !important; }
      .light-text { color: #ffffff !important; }
      .light-text-secondary { color: #a3a3a3 !important; }
      .light-border { border-color: #262626 !important; }
      .light-detail-box { background-color: #1f1f1f !important; color: #ffffff !important; }
    }

    /* Outlook dark mode */
    [data-ogsc] .email-card { background-color: #141414 !important; }
    [data-ogsc] .text-primary { color: #ffffff !important; }
    [data-ogsc] .text-secondary { color: #a3a3a3 !important; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${bgOuter}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased;" class="email-bg">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${bgOuter}; padding: 40px 20px;" class="email-bg">
    <tr>
      <td align="center">
        <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" width="600" align="center"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color: ${bgCard}; border-radius: 12px; overflow: hidden; max-width: 600px; width: 100%;" class="email-container email-card ${lightTheme ? 'light-card' : ''}">
          ${headerRow}

          <!-- Content -->
          <tr>
            <td style="padding: 40px;" class="email-content">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: ${bgFooter}; padding: 25px 40px; border-top: 1px solid ${borderColor};" class="email-footer-bg ${lightTheme ? 'light-bg' : ''}">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="font-size: 13px; margin: 0; line-height: 1.5;">
                      ${brandHtml}
                    </p>
                  </td>
                  <td align="right">
                    <a href="${SITE_URL}" style="text-decoration: none; font-size: 13px; color: ${linkColor};" class="text-primary">freshwax.co.uk</a>
                  </td>
                </tr>
                ${footerExtra ? `
                <tr>
                  <td colspan="2" style="padding-top: 12px;">
                    ${footerExtra}
                  </td>
                </tr>` : ''}
              </table>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build a standard CTA button (table-based for Outlook compatibility).
 * Touch target is 48px+ tall, high contrast.
 */
export function ctaButton(text: string, href: string, options?: {
  gradient?: string;
  textColor?: string;
}): string {
  const gradient = options?.gradient || 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
  const textColor = options?.textColor || '#ffffff';

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding: 10px 0 30px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="17%" strokecolor="#dc2626" fillcolor="#dc2626">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">${esc(text)}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${href}" style="display: inline-block; background: ${gradient}; color: ${textColor}; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-weight: 700; font-size: 16px; letter-spacing: 0.3px; line-height: 1; mso-padding-alt: 0;" class="cta-button">
          ${esc(text)}
        </a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
}

/**
 * Build a details/info box with consistent styling.
 */
export function detailBox(rows: Array<{ label: string; value: string; valueColor?: string }>): string {
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="color: #737373; font-size: 14px; padding-bottom: 10px;" class="text-muted">${r.label}</td>
      <td align="right" style="color: ${r.valueColor || '#ffffff'}; font-size: 14px; padding-bottom: 10px;" class="text-primary">${r.value}</td>
    </tr>`).join('');

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1f1f1f; border-radius: 8px; margin-bottom: 25px;" class="detail-box">
    <tr>
      <td style="padding: 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rowsHtml}
        </table>
      </td>
    </tr>
  </table>`;
}
