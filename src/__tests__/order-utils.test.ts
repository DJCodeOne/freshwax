import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external modules before importing the module under test
vi.mock('../lib/firebase-rest', () => ({
  getDocument: vi.fn(),
  updateDocument: vi.fn(),
  addDocument: vi.fn(),
  setDocument: vi.fn(),
  clearCache: vi.fn(),
  atomicIncrement: vi.fn(),
  updateDocumentConditional: vi.fn(),
  queryCollection: vi.fn(),
}));

vi.mock('../lib/d1-catalog', () => ({
  d1UpsertMerch: vi.fn(),
}));

vi.mock('../lib/vinyl-order-emails', () => ({
  sendVinylOrderSellerEmail: vi.fn(),
  sendVinylOrderAdminEmail: vi.fn(),
}));

import {
  generateOrderNumber,
  getShortOrderNumber,
  validateStock,
  reserveStock,
  releaseReservation,
  convertReservation,
  updateMerchStock,
} from '../lib/order-utils';

import {
  getDocument,
  updateDocument,
  setDocument,
  updateDocumentConditional,
  queryCollection,
  addDocument,
  atomicIncrement,
  clearCache,
} from '../lib/firebase-rest';

const mockGetDocument = vi.mocked(getDocument);
const mockUpdateDocument = vi.mocked(updateDocument);
const mockSetDocument = vi.mocked(setDocument);
const mockUpdateDocumentConditional = vi.mocked(updateDocumentConditional);
const mockQueryCollection = vi.mocked(queryCollection);
const mockAddDocument = vi.mocked(addDocument);
const mockAtomicIncrement = vi.mocked(atomicIncrement);

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================
// generateOrderNumber
// =============================================
describe('generateOrderNumber', () => {
  it('returns a string starting with FW-', () => {
    const num = generateOrderNumber();
    expect(num).toMatch(/^FW-/);
  });

  it('includes a 6-digit date segment (YYMMDD)', () => {
    const num = generateOrderNumber();
    // Format: FW-YYMMDD-RANDOM
    const parts = num.split('-');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^\d{6}$/);
  });

  it('includes a 6-char uppercase random suffix', () => {
    const num = generateOrderNumber();
    const parts = num.split('-');
    expect(parts[2]).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('generates unique order numbers', () => {
    const numbers = new Set(Array.from({ length: 100 }, () => generateOrderNumber()));
    // With 36^6 possibilities, 100 should all be unique
    expect(numbers.size).toBe(100);
  });
});

// =============================================
// getShortOrderNumber
// =============================================
describe('getShortOrderNumber', () => {
  it('returns FW-RANDOM (first + last segment, uppercased)', () => {
    expect(getShortOrderNumber('FW-241204-abc123')).toBe('FW-ABC123');
  });

  it('handles already-uppercase input', () => {
    expect(getShortOrderNumber('FW-241204-XYZ789')).toBe('FW-XYZ789');
  });

  it('returns uppercased input when fewer than 3 segments', () => {
    expect(getShortOrderNumber('SIMPLE')).toBe('SIMPLE');
  });

  it('handles two-segment input', () => {
    expect(getShortOrderNumber('FW-abc')).toBe('FW-ABC');
  });

  it('handles extra segments by taking first and last', () => {
    expect(getShortOrderNumber('FW-241204-extra-abc123')).toBe('FW-ABC123');
  });
});

// =============================================
// validateStock
// =============================================
describe('validateStock', () => {
  it('returns available=true for empty cart', async () => {
    const result = await validateStock([]);
    expect(result.available).toBe(true);
    expect(result.unavailableItems).toHaveLength(0);
  });

  it('returns available=true for digital-only items (unlimited stock)', async () => {
    const items = [
      { type: 'digital', name: 'Track A', releaseId: 'rel1', quantity: 1 },
      { type: 'digital', name: 'Track B', releaseId: 'rel2', quantity: 5 },
    ];
    // Digital items don't even trigger getDocument calls
    const result = await validateStock(items);
    expect(result.available).toBe(true);
    expect(result.unavailableItems).toHaveLength(0);
  });

  it('detects out-of-stock merch (variant level)', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'l_black': { stock: 0, reserved: 0 },
      },
      totalStock: 0,
    });

    const items = [
      { type: 'merch', productId: 'tshirt1', name: 'T-Shirt', size: 'L', color: 'Black', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems).toHaveLength(1);
    expect(result.unavailableItems[0]).toContain('T-Shirt');
    expect(result.unavailableItems[0]).toContain('0 available');
  });

  it('detects merch where reserved exceeds available stock', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'm_red': { stock: 5, reserved: 4 },
      },
    });

    const items = [
      { type: 'merch', productId: 'hoodie1', name: 'Hoodie', size: 'M', color: 'Red', quantity: 3 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems).toHaveLength(1);
    expect(result.unavailableItems[0]).toContain('Hoodie');
    expect(result.unavailableItems[0]).toContain('1 available');
  });

  it('returns available=true when merch is in stock', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'l_black': { stock: 10, reserved: 2 },
      },
    });

    const items = [
      { type: 'merch', productId: 'tshirt1', name: 'T-Shirt', size: 'L', color: 'Black', quantity: 3 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(true);
  });

  it('checks merch totalStock when no size/color specified', async () => {
    mockGetDocument.mockResolvedValue({
      totalStock: 5,
      reservedStock: 3,
    });

    const items = [
      { type: 'merch', productId: 'sticker1', name: 'Sticker Pack', quantity: 3 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems[0]).toContain('Sticker Pack');
    expect(result.unavailableItems[0]).toContain('2 available');
  });

  it('validates vinyl stock', async () => {
    mockGetDocument.mockResolvedValue({
      vinylStock: 2,
    });

    const items = [
      { type: 'vinyl', releaseId: 'rel1', name: 'Album Vinyl', quantity: 5 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems[0]).toContain('Album Vinyl');
    expect(result.unavailableItems[0]).toContain('2 available');
  });

  it('returns available=true for vinyl in stock', async () => {
    mockGetDocument.mockResolvedValue({
      vinylStock: 10,
    });

    const items = [
      { type: 'vinyl', releaseId: 'rel1', name: 'Album Vinyl', quantity: 2 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(true);
  });

  it('detects sold vinyl crates listings', async () => {
    mockGetDocument.mockResolvedValue({
      status: 'sold',
    });

    const items = [
      { type: 'vinyl', sellerId: 'seller1', id: 'listing1', name: 'Rare 12"', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems[0]).toContain('already sold');
  });

  it('detects unpublished vinyl crates listings', async () => {
    mockGetDocument.mockResolvedValue({
      status: 'draft',
    });

    const items = [
      { type: 'vinyl', sellerId: 'seller1', id: 'listing1', name: 'Draft Vinyl', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems[0]).toContain('no longer available');
  });

  it('detects missing vinyl crates listing', async () => {
    mockGetDocument.mockResolvedValue(null);

    const items = [
      { type: 'vinyl', sellerId: 'seller1', id: 'listing1', name: 'Gone Vinyl', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems[0]).toContain('no longer exists');
  });

  it('approves published vinyl crates listing', async () => {
    mockGetDocument.mockResolvedValue({
      status: 'published',
    });

    const items = [
      { type: 'vinyl', sellerId: 'seller1', id: 'listing1', name: 'Available Vinyl', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(true);
  });

  it('handles mixed cart with in-stock and out-of-stock items', async () => {
    // Set up different responses based on call order
    // Items: merch (in stock), vinyl (out of stock), digital (always ok)
    mockGetDocument
      // First call batch: merch
      .mockResolvedValueOnce({
        variantStock: { 'm_black': { stock: 10, reserved: 0 } },
      })
      // Second call batch: vinyl release
      .mockResolvedValueOnce({
        vinylStock: 0,
      })
      // Third call batch: vinyl listing (none here)
    ;

    const items = [
      { type: 'merch', productId: 'shirt1', name: 'Shirt', size: 'M', color: 'Black', quantity: 1 },
      { type: 'vinyl', releaseId: 'rel1', name: 'Vinyl LP', quantity: 1 },
      { type: 'digital', name: 'MP3', releaseId: 'rel2', quantity: 1 },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(false);
    expect(result.unavailableItems).toHaveLength(1);
    expect(result.unavailableItems[0]).toContain('Vinyl LP');
  });

  it('defaults item type to digital when not specified', async () => {
    const items = [
      { name: 'Mystery Item', releaseId: 'rel1', quantity: 1 },
    ];
    // Digital items skip stock check entirely
    const result = await validateStock(items);
    expect(result.available).toBe(true);
  });

  it('defaults quantity to 1', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        's_default': { stock: 1, reserved: 0 },
      },
    });

    const items = [
      { type: 'merch', productId: 'p1', name: 'Item', size: 'S' },
    ];

    const result = await validateStock(items);
    expect(result.available).toBe(true);
  });
});

// =============================================
// reserveStock
// =============================================
describe('reserveStock', () => {
  it('returns success immediately for non-reservable items', async () => {
    const items = [
      { type: 'digital', name: 'Track', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(true);
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it('returns success for empty cart', async () => {
    const result = await reserveStock([], 'session123');
    expect(result.success).toBe(true);
  });

  it('reserves merch stock and creates reservation record', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'l_black': { stock: 10, reserved: 0 },
      },
      _updateTime: '2024-01-01T00:00:00Z',
    });
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockSetDocument.mockResolvedValue({ success: true, id: 'mock-id' });

    const items = [
      { type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 2 },
    ];

    const result = await reserveStock(items, 'session123', 'user456');
    expect(result.success).toBe(true);
    expect(result.reservationId).toBeDefined();
    expect(result.expiresAt).toBeDefined();

    // Verify the stock document was updated
    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 2 }),
        }),
      }),
      '2024-01-01T00:00:00Z'
    );

    // Verify reservation record was stored
    expect(mockSetDocument).toHaveBeenCalledWith(
      'stock-reservations',
      expect.stringMatching(/^res_/),
      expect.objectContaining({
        sessionId: 'session123',
        userId: 'user456',
        status: 'active',
      })
    );
  });

  it('fails when stock is insufficient', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'm_red': { stock: 2, reserved: 1 },
      },
    });

    const items = [
      { type: 'merch', productId: 'hoodie1', size: 'M', color: 'Red', quantity: 5 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient stock');
  });

  it('fails when product not found', async () => {
    mockGetDocument.mockResolvedValue(null);

    const items = [
      { type: 'merch', productId: 'nonexistent', size: 'M', color: 'Black', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Product not found');
  });

  it('fails when variant not found', async () => {
    // Empty variantStock — product exists but has no stock entries
    mockGetDocument.mockResolvedValue({
      variantStock: {},
      _updateTime: '2024-01-01T00:00:00Z',
    });

    const items = [
      { type: 'merch', productId: 'shirt1', size: 'XXL', color: 'Pink', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Variant not found');
  });

  it('retries on CONFLICT error and succeeds', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        variantStock: { 'l_black': { stock: 10, reserved: 0 } },
        _updateTime: 'time1',
      })
      .mockResolvedValueOnce({
        variantStock: { 'l_black': { stock: 10, reserved: 1 } },
        _updateTime: 'time2',
      });

    mockUpdateDocumentConditional
      .mockRejectedValueOnce(new Error('CONFLICT: document modified'))
      .mockResolvedValueOnce({ success: true });

    mockSetDocument.mockResolvedValue({ success: true, id: 'mock-id' });

    const items = [
      { type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(true);
    expect(mockGetDocument).toHaveBeenCalledTimes(2);
  });

  it('normalizes size and color (lowercase, spaces to hyphens)', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'x-large_dark-blue': { stock: 5, reserved: 0 },
      },
      _updateTime: 'time1',
    });
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockSetDocument.mockResolvedValue({ success: true, id: 'mock-id' });

    const items = [
      { type: 'merch', productId: 'shirt1', size: 'X Large', color: 'Dark Blue', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(true);
  });

  it('defaults size to onesize and color to default', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'onesize_default': { stock: 5, reserved: 0 },
      },
      _updateTime: 'time1',
    });
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockSetDocument.mockResolvedValue({ success: true, id: 'mock-id' });

    const items = [
      { type: 'merch', productId: 'sticker1', quantity: 1 },
    ];

    const result = await reserveStock(items, 'session123');
    expect(result.success).toBe(true);
  });
});

// =============================================
// releaseReservation
// =============================================
describe('releaseReservation', () => {
  it('does nothing when reservation not found', async () => {
    mockGetDocument.mockResolvedValue(null);
    mockQueryCollection.mockResolvedValue([]);

    await releaseReservation('nonexistent');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('does nothing when reservation is already expired', async () => {
    mockGetDocument.mockResolvedValue({
      id: 'res1',
      status: 'expired',
      items: [],
    });

    await releaseReservation('res1');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('releases stock and marks reservation as expired', async () => {
    mockGetDocument
      // First call: the reservation itself
      .mockResolvedValueOnce({
        id: 'res1',
        status: 'active',
        items: [
          { productId: 'shirt1', variantKey: 'l_black', quantity: 2 },
        ],
      })
      // Second call: the merch product
      .mockResolvedValueOnce({
        variantStock: {
          'l_black': { stock: 10, reserved: 5 },
        },
        _updateTime: 'time1',
      });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res1');

    // Check that reserved count was decremented
    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 3 }),
        }),
      }),
      'time1'
    );

    // Check reservation marked as expired
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations',
      'res1',
      expect.objectContaining({ status: 'expired' })
    );
  });

  it('finds reservation by sessionId when direct lookup fails', async () => {
    mockGetDocument.mockResolvedValueOnce(null); // Direct lookup fails
    mockQueryCollection.mockResolvedValueOnce([
      {
        id: 'res_found',
        status: 'active',
        items: [],
      },
    ]);
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('session123');

    expect(mockQueryCollection).toHaveBeenCalledWith('stock-reservations', {
      filters: [
        { field: 'sessionId', op: 'EQUAL', value: 'session123' },
        { field: 'status', op: 'EQUAL', value: 'active' },
      ],
      limit: 1,
    });

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations',
      'res_found',
      expect.objectContaining({ status: 'expired' })
    );
  });

  it('never decrements reserved below zero', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        id: 'res1',
        status: 'active',
        items: [
          { productId: 'shirt1', variantKey: 'l_black', quantity: 10 },
        ],
      })
      .mockResolvedValueOnce({
        variantStock: {
          'l_black': { stock: 10, reserved: 3 }, // reserved < quantity to release
        },
        _updateTime: 'time1',
      });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res1');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 0 }), // Math.max(0, 3-10)
        }),
      }),
      'time1'
    );
  });
});

// =============================================
// convertReservation
// =============================================
describe('convertReservation', () => {
  it('converts active reservation to converted status', async () => {
    mockGetDocument.mockResolvedValue({
      id: 'res1',
      status: 'active',
    });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await convertReservation('res1');

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations',
      'res1',
      expect.objectContaining({ status: 'converted' })
    );
  });

  it('does nothing for non-active reservation', async () => {
    mockGetDocument.mockResolvedValue({
      id: 'res1',
      status: 'expired',
    });

    await convertReservation('res1');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('does nothing when reservation not found', async () => {
    mockGetDocument.mockResolvedValue(null);
    mockQueryCollection.mockResolvedValue([]);

    await convertReservation('nonexistent');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('finds reservation by sessionId via query', async () => {
    mockGetDocument.mockResolvedValueOnce(null); // Direct lookup fails
    mockQueryCollection.mockResolvedValueOnce([
      { id: 'res_found', status: 'active' },
    ]);
    mockUpdateDocument.mockResolvedValue({ success: true });

    await convertReservation('session123');

    expect(mockQueryCollection).toHaveBeenCalled();
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations',
      'res_found',
      expect.objectContaining({ status: 'converted' })
    );
  });
});

// =============================================
// updateMerchStock
// =============================================
describe('updateMerchStock', () => {
  it('decrements variant stock and records movement', async () => {
    const productData = {
      variantStock: {
        'l_black': { stock: 10, sold: 2, reserved: 1 },
      },
      _updateTime: 'time1',
      sku: 'SHIRT-001',
      lowStockThreshold: 5,
    };

    mockGetDocument.mockResolvedValue(productData);
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockAddDocument.mockResolvedValue({ success: true, id: 'movement1' });

    const items = [
      { type: 'merch', productId: 'shirt1', name: 'T-Shirt', size: 'L', color: 'Black', quantity: 2 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC123', 'order1');

    // The function reads the doc, updates, then reads again for movement logging
    expect(mockGetDocument).toHaveBeenCalled();
    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({
            stock: 8,
            sold: 4,
            reserved: 0, // Math.max(0, 1 - 2)
          }),
        }),
        totalStock: 8,
        soldStock: 4,
      }),
      'time1'
    );
  });

  it('skips items without matching variant key', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'l_black': { stock: 10, sold: 0, reserved: 0 },
      },
    });

    const items = [
      { type: 'merch', productId: 'shirt1', name: 'T-Shirt', size: 'XXL', color: 'Pink', quantity: 1 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC', 'order1');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
    expect(mockUpdateDocumentConditional).not.toHaveBeenCalled();
  });

  it('skips non-merch items', async () => {
    const items = [
      { type: 'digital', name: 'Track', quantity: 1 },
      { type: 'vinyl', name: 'Vinyl LP', releaseId: 'r1', quantity: 1 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC', 'order1');
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it('sets isOutOfStock when stock reaches zero', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'onesize_default': { stock: 1, sold: 9, reserved: 0 },
      },
      _updateTime: 'time1',
      lowStockThreshold: 5,
    });
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockAddDocument.mockResolvedValue({ success: true, id: 'movement1' });

    const items = [
      { type: 'merch', productId: 'p1', name: 'Sticker', quantity: 1 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC', 'order1');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'p1',
      expect.objectContaining({
        isOutOfStock: true,
        totalStock: 0,
      }),
      'time1'
    );
  });

  it('sets isLowStock when stock falls below threshold', async () => {
    mockGetDocument.mockResolvedValue({
      variantStock: {
        'm_black': { stock: 6, sold: 0, reserved: 0 },
      },
      _updateTime: 'time1',
      lowStockThreshold: 5,
    });
    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockAddDocument.mockResolvedValue({ success: true, id: 'movement1' });

    const items = [
      { type: 'merch', productId: 'p1', name: 'Hoodie', size: 'M', color: 'Black', quantity: 2 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC', 'order1');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch',
      'p1',
      expect.objectContaining({
        isLowStock: true,
        isOutOfStock: false,
        totalStock: 4,
      }),
      'time1'
    );
  });

  it('retries on CONFLICT and eventually succeeds', async () => {
    const productV1 = {
      variantStock: { 'l_black': { stock: 10, sold: 0, reserved: 0 } },
      _updateTime: 'time1',
    };
    const productV2 = {
      variantStock: { 'l_black': { stock: 10, sold: 0, reserved: 0 } },
      _updateTime: 'time2',
    };

    mockGetDocument
      .mockResolvedValueOnce(productV1)  // First read
      .mockResolvedValueOnce(productV2)  // Second read (retry)
      .mockResolvedValue(productV2);     // For movement logging reads

    mockUpdateDocumentConditional
      .mockRejectedValueOnce(new Error('CONFLICT'))
      .mockResolvedValueOnce({ success: true });

    mockAddDocument.mockResolvedValue({ success: true, id: 'movement1' });

    const items = [
      { type: 'merch', productId: 'shirt1', name: 'T-Shirt', size: 'L', color: 'Black', quantity: 1 },
    ];

    await updateMerchStock(items, 'FW-240101-ABC', 'order1');

    // Should have been called twice (once failed, once succeeded)
    expect(mockUpdateDocumentConditional).toHaveBeenCalledTimes(2);
  });
});
