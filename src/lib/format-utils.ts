// src/lib/format-utils.ts
// Shared formatting utilities

/**
 * Format a numeric amount as a GBP price string (e.g. "£12.99")
 */
export function formatPrice(amount: number): string {
  return `£${amount.toFixed(2)}`;
}
