// src/lib/format-utils.ts
// Shared formatting utilities

/**
 * Format a numeric amount as a GBP price string (e.g. "£12.99")
 */
export function formatPrice(amount: number): string {
  return `£${amount.toFixed(2)}`;
}

/**
 * Format a date string in long format (e.g. "15 March 2026")
 */
export function formatDateLong(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

/**
 * Format a date string in short format (e.g. "15 Mar 2026")
 */
export function formatDateShort(dateString: string): string {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Estimate reading time for HTML content (avg 200 words per minute)
 */
export function getReadTime(content: string): string {
  if (!content) return '1 min read';
  const text = content.replace(/<[^>]*>/g, '');
  const words = text.split(/\s+/).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}
