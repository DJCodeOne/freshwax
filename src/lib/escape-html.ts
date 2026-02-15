// src/lib/escape-html.ts
// Standalone HTML escape utility — safe to import from both server and client scripts.
// Handles null/undefined gracefully by returning an empty string.
export function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}
