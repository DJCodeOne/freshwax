// src/lib/order/utils.ts
// Order number generation utilities

// Generate order number
export function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FW-${year}${month}${day}-${random}`;
}

// Get short order number for display (e.g., "FW-ABC123" from "FW-241204-abc123")
export function getShortOrderNumber(orderNumber: string): string {
  const orderParts = orderNumber.split('-');
  return orderParts.length >= 3
    ? (orderParts[0] + '-' + orderParts[orderParts.length - 1]).toUpperCase()
    : orderNumber.toUpperCase();
}
