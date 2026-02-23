import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../lib/escape-html';

// =============================================
// escapeHtml (standalone module)
// =============================================
describe('escapeHtml', () => {
  it('passes through basic strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('passes through numbers and safe characters', () => {
    expect(escapeHtml('Price: 9.99 (GBP)')).toBe('Price: 9.99 (GBP)');
  });

  it('escapes <script> tags', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a "quoted" value')).toBe('a &quot;quoted&quot; value');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes all five special characters together', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles a complex XSS payload', () => {
    const payload = '<img src=x onerror="alert(document.cookie)">';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
  });

  it('preserves unicode characters without mangling', () => {
    expect(escapeHtml('cafe\u0301 \u2603')).toBe('cafe\u0301 \u2603');
  });

  it('handles strings with only special characters', () => {
    expect(escapeHtml('<<<>>>')).toBe('&lt;&lt;&lt;&gt;&gt;&gt;');
  });
});
