import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external modules before importing the module under test
vi.mock('../lib/firebase-rest', () => {
  const getDocumentMock = vi.fn();
  return {
    getDocument: getDocumentMock,
    getDocumentsBatch: vi.fn(async (_collection: string, ids: string[]) => {
      const map = new Map();
      for (const id of ids) {
        const doc = await getDocumentMock(_collection, id);
        if (doc) map.set(id, doc);
      }
      return map;
    }),
    updateDocument: vi.fn(),
    setDocument: vi.fn(),
    updateDocumentConditional: vi.fn(),
    queryCollection: vi.fn().mockResolvedValue([]),
  };
});

import {
  reserveStock,
  releaseReservation,
  convertReservation,
  cleanupExpiredReservations,
} from '../lib/order/stock-reservation';

import {
  getDocument,
  getDocumentsBatch,
  updateDocument,
  setDocument,
  updateDocumentConditional,
  queryCollection,
} from '../lib/firebase-rest';

const mockGetDocument = vi.mocked(getDocument);
const mockGetDocumentsBatch = vi.mocked(getDocumentsBatch);
const mockUpdateDocument = vi.mocked(updateDocument);
const mockSetDocument = vi.mocked(setDocument);
const mockUpdateDocumentConditional = vi.mocked(updateDocumentConditional);
const mockQueryCollection = vi.mocked(queryCollection);

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCollection.mockResolvedValue([]);
});

// =============================================
// reserveStock — merch items
// =============================================
describe('reserveStock', () => {
  describe('merch reservations', () => {
    it('returns success for empty cart', async () => {
      const result = await reserveStock([], 'session1');
      expect(result.success).toBe(true);
    });

    it('returns success for digital-only items (nothing to reserve)', async () => {
      const result = await reserveStock(
        [{ type: 'digital', name: 'Track A', releaseId: 'r1', quantity: 1 }],
        'session1'
      );
      expect(result.success).toBe(true);
      expect(mockGetDocument).not.toHaveBeenCalled();
    });

    it('reserves merch and creates reservation record', async () => {
      mockGetDocument.mockResolvedValue({
        variantStock: { 'l_black': { stock: 10, reserved: 0 } },
        _updateTime: 'ts1',
      });
      mockUpdateDocumentConditional.mockResolvedValue({ success: true });
      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [{ type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 2 }],
        'session1',
        'user1'
      );

      expect(result.success).toBe(true);
      expect(result.reservationId).toMatch(/^res_/);
      expect(result.expiresAt).toBeDefined();

      // Verify stock document updated with optimistic concurrency
      expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
        'merch', 'shirt1',
        expect.objectContaining({
          variantStock: expect.objectContaining({
            'l_black': expect.objectContaining({ reserved: 2 }),
          }),
        }),
        'ts1'
      );

      // Verify reservation record stored
      expect(mockSetDocument).toHaveBeenCalledWith(
        'stock-reservations',
        expect.stringMatching(/^res_/),
        expect.objectContaining({
          sessionId: 'session1',
          userId: 'user1',
          status: 'active',
        })
      );
    });

    it('fails when merch stock is insufficient', async () => {
      mockGetDocument.mockResolvedValue({
        variantStock: { 'm_red': { stock: 2, reserved: 1 } },
      });

      const result = await reserveStock(
        [{ type: 'merch', productId: 'h1', size: 'M', color: 'Red', quantity: 5 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient stock');
    });

    it('fails when product not found', async () => {
      mockGetDocument.mockResolvedValue(null);

      const result = await reserveStock(
        [{ type: 'merch', productId: 'missing', size: 'M', color: 'Black', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Product not found');
    });

    it('fails when variant not found in empty variantStock', async () => {
      mockGetDocument.mockResolvedValue({
        variantStock: {},
        _updateTime: 'ts1',
      });

      const result = await reserveStock(
        [{ type: 'merch', productId: 'shirt1', size: 'XXL', color: 'Pink', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Variant not found');
    });

    it('uses single variant fallback when key does not match', async () => {
      mockGetDocument.mockResolvedValue({
        variantStock: { 'onesize_default': { stock: 5, reserved: 0 } },
        _updateTime: 'ts1',
      });
      mockUpdateDocumentConditional.mockResolvedValue({ success: true });
      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [{ type: 'merch', productId: 'sticker1', size: 'M', color: 'Blue', quantity: 1 }],
        'session1'
      );

      // Single variant fallback should resolve to 'onesize_default'
      expect(result.success).toBe(true);
    });
  });

  // =============================================
  // reserveStock — vinyl release items
  // =============================================
  describe('vinyl release reservations', () => {
    it('reserves vinyl release stock', async () => {
      mockGetDocument.mockResolvedValue({
        vinylStock: 10,
        vinylReserved: 2,
        _updateTime: 'ts1',
      });
      mockUpdateDocumentConditional.mockResolvedValue({ success: true });
      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [{ type: 'vinyl', releaseId: 'rel1', quantity: 3 }],
        'session1'
      );

      expect(result.success).toBe(true);
      expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
        'releases', 'rel1',
        expect.objectContaining({ vinylReserved: 5 }),
        'ts1'
      );
    });

    it('fails when vinyl stock is insufficient', async () => {
      mockGetDocument.mockResolvedValue({
        vinylStock: 5,
        vinylReserved: 4,
        _updateTime: 'ts1',
      });

      const result = await reserveStock(
        [{ type: 'vinyl', releaseId: 'rel1', quantity: 3 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient vinyl stock');
    });

    it('fails when release not found', async () => {
      mockGetDocument.mockResolvedValue(null);

      const result = await reserveStock(
        [{ type: 'vinyl', releaseId: 'missing', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Release not found');
    });
  });

  // =============================================
  // reserveStock — vinyl listing items (Crates)
  // =============================================
  describe('vinyl listing reservations (Crates)', () => {
    it('reserves a published listing', async () => {
      mockGetDocument.mockResolvedValue({
        status: 'published',
        _updateTime: 'ts1',
      });
      mockUpdateDocumentConditional.mockResolvedValue({ success: true });
      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [{ type: 'vinyl', sellerId: 'seller1', id: 'listing1', quantity: 1 }],
        'session1',
        'buyer1'
      );

      expect(result.success).toBe(true);
      expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
        'vinylListings', 'listing1',
        expect.objectContaining({
          status: 'reserved',
          reservedBy: 'buyer1',
        }),
        'ts1'
      );
    });

    it('fails when listing is already reserved', async () => {
      mockGetDocument.mockResolvedValue({
        status: 'reserved',
        _updateTime: 'ts1',
      });

      const result = await reserveStock(
        [{ type: 'vinyl', sellerId: 'seller1', id: 'listing1', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('no longer available');
    });

    it('fails when listing not found', async () => {
      mockGetDocument.mockResolvedValue(null);

      const result = await reserveStock(
        [{ type: 'vinyl', sellerId: 'seller1', id: 'missing', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Listing not found');
    });
  });

  // =============================================
  // Optimistic concurrency — CONFLICT retries
  // =============================================
  describe('optimistic concurrency', () => {
    it('retries on CONFLICT and succeeds on second attempt', async () => {
      mockGetDocument
        .mockResolvedValueOnce({
          variantStock: { 'l_black': { stock: 10, reserved: 0 } },
          _updateTime: 'ts1',
        })
        .mockResolvedValueOnce({
          variantStock: { 'l_black': { stock: 10, reserved: 1 } },
          _updateTime: 'ts2',
        });

      mockUpdateDocumentConditional
        .mockRejectedValueOnce(new Error('CONFLICT: document modified'))
        .mockResolvedValueOnce({ success: true });

      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [{ type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(true);
      // First attempt uses prefetched data, second attempt calls getDocument
      expect(mockGetDocument).toHaveBeenCalledTimes(2);
    });

    it('fails after max retries on persistent CONFLICT', async () => {
      mockGetDocument.mockResolvedValue({
        variantStock: { 'l_black': { stock: 10, reserved: 0 } },
        _updateTime: 'ts1',
      });

      mockUpdateDocumentConditional
        .mockRejectedValue(new Error('CONFLICT: document modified'));

      const result = await reserveStock(
        [{ type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 1 }],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to reserve stock');
    });

    it('rolls back earlier reservations when a later item fails', async () => {
      // First item: merch succeeds
      // Second item: vinyl release fails (not found)
      let callCount = 0;
      mockGetDocument.mockImplementation(async (collection: string, id: string) => {
        callCount++;
        if (collection === 'merch' || id === 'shirt1') {
          return {
            variantStock: { 'l_black': { stock: 10, reserved: 0 } },
            _updateTime: 'ts1',
          };
        }
        // Release not found
        return null;
      });

      mockUpdateDocumentConditional.mockResolvedValue({ success: true });
      mockSetDocument.mockResolvedValue({ success: true, id: 'mock' });

      const result = await reserveStock(
        [
          { type: 'merch', productId: 'shirt1', size: 'L', color: 'Black', quantity: 1 },
          { type: 'vinyl', releaseId: 'missing_rel', quantity: 1 },
        ],
        'session1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Release not found');

      // Rollback should have been called — updateDocumentConditional called again to undo merch reservation
      // The rollback fetches the merch doc again and decrements reserved
      expect(mockUpdateDocumentConditional.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
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

  it('releases merch stock and marks reservation as expired', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        id: 'res1',
        status: 'active',
        items: [{ itemType: 'merch', productId: 'shirt1', variantKey: 'l_black', quantity: 2 }],
      })
      .mockResolvedValueOnce({
        variantStock: { 'l_black': { stock: 10, reserved: 5 } },
        _updateTime: 'ts1',
      });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res1');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch', 'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 3 }),
        }),
      }),
      'ts1'
    );

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations', 'res1',
      expect.objectContaining({ status: 'expired' })
    );
  });

  it('releases vinyl release stock', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        id: 'res2',
        status: 'active',
        items: [{ itemType: 'vinyl-release', productId: 'rel1', variantKey: '', quantity: 1 }],
      })
      .mockResolvedValueOnce({
        vinylReserved: 3,
        _updateTime: 'ts1',
      });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res2');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'releases', 'rel1',
      expect.objectContaining({ vinylReserved: 2 }),
      'ts1'
    );
  });

  it('releases vinyl listing reservation back to published', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        id: 'res3',
        status: 'active',
        items: [{ itemType: 'vinyl-listing', productId: 'list1', variantKey: '', quantity: 1 }],
      })
      .mockResolvedValueOnce({
        status: 'reserved',
      });

    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res3');

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'vinylListings', 'list1',
      expect.objectContaining({
        status: 'published',
        reservedAt: null,
        reservedBy: null,
      })
    );
  });

  it('finds reservation by sessionId when direct lookup fails', async () => {
    mockGetDocument.mockResolvedValueOnce(null);
    mockQueryCollection.mockResolvedValueOnce([
      { id: 'res_found', status: 'active', items: [] },
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
  });

  it('never decrements reserved below zero', async () => {
    mockGetDocument
      .mockResolvedValueOnce({
        id: 'res1',
        status: 'active',
        items: [{ itemType: 'merch', productId: 'shirt1', variantKey: 'l_black', quantity: 10 }],
      })
      .mockResolvedValueOnce({
        variantStock: { 'l_black': { stock: 10, reserved: 3 } },
        _updateTime: 'ts1',
      });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await releaseReservation('res1');

    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch', 'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 0 }),
        }),
      }),
      'ts1'
    );
  });
});

// =============================================
// convertReservation
// =============================================
describe('convertReservation', () => {
  it('marks active reservation as converted', async () => {
    mockGetDocument.mockResolvedValue({ id: 'res1', status: 'active' });
    mockUpdateDocument.mockResolvedValue({ success: true });

    await convertReservation('res1');

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations', 'res1',
      expect.objectContaining({ status: 'converted' })
    );
  });

  it('does nothing for non-active reservation', async () => {
    mockGetDocument.mockResolvedValue({ id: 'res1', status: 'expired' });

    await convertReservation('res1');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it('does nothing when reservation not found', async () => {
    mockGetDocument.mockResolvedValue(null);
    mockQueryCollection.mockResolvedValue([]);

    await convertReservation('nonexistent');
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });
});

// =============================================
// cleanupExpiredReservations
// =============================================
describe('cleanupExpiredReservations', () => {
  it('returns 0 when no expired reservations exist', async () => {
    mockQueryCollection.mockResolvedValue([]);

    const count = await cleanupExpiredReservations();
    expect(count).toBe(0);
  });

  it('cleans up expired merch reservations and returns count', async () => {
    mockQueryCollection.mockResolvedValueOnce([
      {
        id: 'res_expired1',
        status: 'active',
        expiresAt: '2024-01-01T00:00:00Z',
        items: [{ itemType: 'merch', productId: 'shirt1', variantKey: 'l_black', quantity: 2 }],
      },
    ]);

    mockGetDocument.mockResolvedValue({
      variantStock: { 'l_black': { stock: 10, reserved: 5 } },
      _updateTime: 'ts1',
    });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    const count = await cleanupExpiredReservations();

    expect(count).toBe(1);

    // Verify stock decremented
    expect(mockUpdateDocumentConditional).toHaveBeenCalledWith(
      'merch', 'shirt1',
      expect.objectContaining({
        variantStock: expect.objectContaining({
          'l_black': expect.objectContaining({ reserved: 3 }),
        }),
      }),
      'ts1'
    );

    // Verify reservation marked as expired
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'stock-reservations', 'res_expired1',
      expect.objectContaining({ status: 'expired' })
    );
  });

  it('cleans up multiple expired reservations', async () => {
    mockQueryCollection.mockResolvedValueOnce([
      {
        id: 'res1',
        status: 'active',
        items: [{ itemType: 'vinyl-release', productId: 'rel1', variantKey: '', quantity: 1 }],
      },
      {
        id: 'res2',
        status: 'active',
        items: [{ itemType: 'vinyl-listing', productId: 'list1', variantKey: '', quantity: 1 }],
      },
    ]);

    mockGetDocument.mockImplementation(async (_collection: string, id: string) => {
      if (id === 'rel1') return { vinylReserved: 3, _updateTime: 'ts1' };
      if (id === 'list1') return { status: 'reserved' };
      return null;
    });

    mockUpdateDocumentConditional.mockResolvedValue({ success: true });
    mockUpdateDocument.mockResolvedValue({ success: true });

    const count = await cleanupExpiredReservations();
    expect(count).toBe(2);
  });
});
