import { describe, it, expect } from 'vitest';

// Mock constants module
vi.mock('../lib/constants', () => ({
  SITE_URL: 'https://freshwax.co.uk',
}));

import { vi } from 'vitest';
import { esc, emailWrapper, ctaButton, detailBox } from '../lib/email-wrapper';

// =============================================
// esc (HTML escaping)
// =============================================
describe('esc', () => {
  it('escapes ampersand', () => {
    expect(esc('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than', () => {
    expect(esc('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(esc('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes (apostrophes)', () => {
    expect(esc("it's")).toBe('it&#x27;s');
  });

  it('escapes all five special chars at once', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#x27;');
  });

  it('returns empty string for null', () => {
    expect(esc(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(esc(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(esc('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  it('handles XSS script injection', () => {
    const xss = '<script>alert("xss")</script>';
    const result = esc(xss);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('</script>');
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('handles event handler injection', () => {
    const payload = '" onmouseover="alert(1)"';
    const result = esc(payload);
    expect(result).not.toContain('" onmouseover');
    expect(result).toContain('&quot;');
  });

  it('preserves unicode characters', () => {
    expect(esc('\u00e9\u00e8\u00ea')).toBe('\u00e9\u00e8\u00ea');
  });

  it('preserves emoji', () => {
    expect(esc('\ud83c\udfb5 Music')).toBe('\ud83c\udfb5 Music');
  });

  it('handles multiple ampersands in a row', () => {
    expect(esc('&&&&')).toBe('&amp;&amp;&amp;&amp;');
  });
});

// =============================================
// emailWrapper
// =============================================
describe('emailWrapper', () => {
  it('produces valid HTML document with doctype', () => {
    const html = emailWrapper('<p>Hello</p>');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('</html>');
  });

  it('includes the content in the body', () => {
    const html = emailWrapper('<p>Your order is confirmed!</p>');
    expect(html).toContain('<p>Your order is confirmed!</p>');
  });

  it('uses default title "Fresh Wax"', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('<title>Fresh Wax</title>');
  });

  it('uses custom title when provided', () => {
    const html = emailWrapper('<p>Test</p>', { title: 'Order Confirmation' });
    expect(html).toContain('<title>Order Confirmation</title>');
  });

  it('escapes custom title to prevent XSS', () => {
    const html = emailWrapper('<p>Test</p>', { title: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes header with default text when no headerText specified', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('Fresh Wax');
  });

  it('includes custom header text', () => {
    const html = emailWrapper('<p>Test</p>', { headerText: 'Order Shipped!' });
    expect(html).toContain('Order Shipped!');
  });

  it('hides header when hideHeader is true', () => {
    const html = emailWrapper('<p>Test</p>', { hideHeader: true });
    // The header row should not be present
    expect(html).not.toContain('<!-- Header -->');
  });

  it('includes header when hideHeader is false (default)', () => {
    const html = emailWrapper('<p>Test</p>', { hideHeader: false });
    expect(html).toContain('<!-- Header -->');
  });

  it('includes default footer branding', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('Fresh');
    expect(html).toContain('Wax');
    expect(html).toContain('Underground Music Platform');
  });

  it('uses custom footer branding when provided', () => {
    const html = emailWrapper('<p>Test</p>', { footerBrand: 'Custom Brand' });
    expect(html).toContain('Custom Brand');
    expect(html).not.toContain('Underground Music Platform');
  });

  it('includes footer extra content', () => {
    const html = emailWrapper('<p>Test</p>', {
      footerExtra: '<a href="/unsubscribe">Unsubscribe</a>',
    });
    expect(html).toContain('<a href="/unsubscribe">Unsubscribe</a>');
  });

  it('omits footer extra section when not provided', () => {
    const html = emailWrapper('<p>Test</p>');
    // With no footerExtra, there should be no extra row in footer
    expect(html).not.toContain('colspan="2"');
  });

  it('includes site URL link in footer', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('href="https://freshwax.co.uk"');
    expect(html).toContain('freshwax.co.uk');
  });

  // Theme tests
  it('uses dark theme colors by default', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('#0a0a0a'); // dark background
    expect(html).toContain('#141414'); // dark card
  });

  it('uses light theme colors when lightTheme is true', () => {
    const html = emailWrapper('<p>Test</p>', { lightTheme: true });
    expect(html).toContain('#f3f4f6'); // light background
    expect(html).toContain('#ffffff'); // white card
  });

  it('adds light-card class for light theme', () => {
    const html = emailWrapper('<p>Test</p>', { lightTheme: true });
    expect(html).toContain('light-card');
  });

  it('uses custom header gradient', () => {
    const gradient = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    const html = emailWrapper('<p>Test</p>', { headerGradient: gradient });
    expect(html).toContain(gradient);
  });

  // Responsive and email client compatibility
  it('includes mobile media query', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('@media only screen and (max-width: 640px)');
  });

  it('includes dark mode media query', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('includes MSO conditional comments for Outlook', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('<!--[if mso]>');
    expect(html).toContain('<![endif]-->');
  });

  it('uses table-based layout for compatibility', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('role="presentation"');
  });

  it('includes viewport meta tag for mobile', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  it('includes color-scheme meta for dark mode support', () => {
    const html = emailWrapper('<p>Test</p>');
    expect(html).toContain('name="color-scheme" content="light dark"');
  });
});

// =============================================
// ctaButton
// =============================================
describe('ctaButton', () => {
  it('generates a link with correct href', () => {
    const btn = ctaButton('Buy Now', 'https://freshwax.co.uk/checkout/');
    expect(btn).toContain('href="https://freshwax.co.uk/checkout/"');
  });

  it('escapes button text to prevent XSS', () => {
    const btn = ctaButton('<script>alert(1)</script>', 'https://example.com');
    expect(btn).not.toContain('<script>');
    expect(btn).toContain('&lt;script&gt;');
  });

  it('uses default red gradient', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)');
  });

  it('uses custom gradient when provided', () => {
    const gradient = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    const btn = ctaButton('Click', 'https://example.com', { gradient });
    expect(btn).toContain(gradient);
  });

  it('uses default white text color', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('color: #ffffff');
  });

  it('uses custom text color when provided', () => {
    const btn = ctaButton('Click', 'https://example.com', { textColor: '#000000' });
    expect(btn).toContain('color: #000000');
  });

  it('includes table-based layout for Outlook', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('role="presentation"');
    expect(btn).toContain('v:roundrect');
  });

  it('includes cta-button class for mobile styles', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('class="cta-button"');
  });

  it('has bold font weight', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('font-weight: 700');
  });

  it('has 16px font size', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('font-size: 16px');
  });

  it('has 8px border radius', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('border-radius: 8px');
  });

  it('has adequate touch target padding (16px vertical)', () => {
    const btn = ctaButton('Click', 'https://example.com');
    expect(btn).toContain('padding: 16px 40px');
  });

  it('renders both MSO and non-MSO versions of the button', () => {
    const btn = ctaButton('View Order', 'https://freshwax.co.uk/orders/123/');
    // MSO version
    expect(btn).toContain('<!--[if mso]>');
    expect(btn).toContain('View Order');
    // Non-MSO version
    expect(btn).toContain('<!--[if !mso]><!-->');
  });
});

// =============================================
// detailBox
// =============================================
describe('detailBox', () => {
  it('renders rows with labels and values', () => {
    const box = detailBox([
      { label: 'Order', value: 'FW-240101-ABC' },
      { label: 'Total', value: '\u00a310.00' },
    ]);
    expect(box).toContain('Order');
    expect(box).toContain('FW-240101-ABC');
    expect(box).toContain('Total');
    expect(box).toContain('\u00a310.00');
  });

  it('applies custom valueColor', () => {
    const box = detailBox([
      { label: 'Status', value: 'Shipped', valueColor: '#22c55e' },
    ]);
    expect(box).toContain('color: #22c55e');
  });

  it('uses default #ffffff for value color when not specified', () => {
    const box = detailBox([
      { label: 'Name', value: 'Test' },
    ]);
    expect(box).toContain('color: #ffffff');
  });

  it('renders empty table for empty rows array', () => {
    const box = detailBox([]);
    expect(box).toContain('detail-box');
    // Should still have the outer table structure
    expect(box).toContain('role="presentation"');
  });

  it('uses dark background styling', () => {
    const box = detailBox([{ label: 'A', value: 'B' }]);
    expect(box).toContain('#1f1f1f'); // dark detail box background
  });

  it('has 8px border radius', () => {
    const box = detailBox([{ label: 'A', value: 'B' }]);
    expect(box).toContain('border-radius: 8px');
  });

  it('uses text-muted class for labels', () => {
    const box = detailBox([{ label: 'Label', value: 'Value' }]);
    expect(box).toContain('class="text-muted"');
  });

  it('uses text-primary class for values', () => {
    const box = detailBox([{ label: 'Label', value: 'Value' }]);
    expect(box).toContain('class="text-primary"');
  });

  it('right-aligns values', () => {
    const box = detailBox([{ label: 'Label', value: 'Value' }]);
    expect(box).toContain('align="right"');
  });

  it('renders multiple rows correctly', () => {
    const rows = [
      { label: 'Item 1', value: 'Value 1' },
      { label: 'Item 2', value: 'Value 2' },
      { label: 'Item 3', value: 'Value 3' },
    ];
    const box = detailBox(rows);
    // Count occurrences of <tr> within the rows (each row = 1 tr)
    const trMatches = box.match(/<tr>/g);
    // Outer table has 1 tr, inner table has 3 rows
    expect(trMatches).not.toBeNull();
    expect(trMatches!.length).toBeGreaterThanOrEqual(3);
  });
});
