import { describe, it, expect } from 'vitest';
import {
  releaseToD1Row,
  merchToD1Row,
  mixToD1Row,
  slotToD1Row,
  ledgerToD1Row,
  vinylSellerToD1Row,
  d1RowToRelease,
  d1RowToMerch,
  d1RowToMix,
  d1RowToSlot,
  d1RowToLedger,
  d1RowToVinylSeller,
} from '../lib/d1-catalog';

// =============================================
// releaseToD1Row
// =============================================
describe('releaseToD1Row', () => {
  it('maps all fields correctly from a complete release document', () => {
    const doc = {
      title: 'Jungle Fury EP',
      artistName: 'DJ TestArtist',
      genre: 'Jungle',
      releaseDate: '2025-01-15',
      status: 'live',
      published: true,
      pricePerSale: 7.99,
      trackPrice: 1.49,
      vinylPrice: 24.99,
      vinylStock: 50,
      coverUrl: '/art/cover.jpg',
      thumbUrl: '/art/thumb.jpg',
      plays: 1200,
      downloads: 340,
      views: 5600,
      likes: 89,
      ratings: { average: 4.5, count: 20 },
      createdAt: '2024-12-01T00:00:00.000Z',
    };

    const row = releaseToD1Row('rel_123', doc);

    expect(row.id).toBe('rel_123');
    expect(row.title).toBe('Jungle Fury EP');
    expect(row.artist_name).toBe('DJ TestArtist');
    expect(row.genre).toBe('Jungle');
    expect(row.release_date).toBe('2025-01-15');
    expect(row.status).toBe('live');
    expect(row.published).toBe(1);
    expect(row.price_per_sale).toBe(7.99);
    expect(row.track_price).toBe(1.49);
    expect(row.vinyl_price).toBe(24.99);
    expect(row.vinyl_stock).toBe(50);
    expect(row.cover_url).toBe('/art/cover.jpg');
    expect(row.thumb_url).toBe('/art/thumb.jpg');
    expect(row.plays).toBe(1200);
    expect(row.downloads).toBe(340);
    expect(row.views).toBe(5600);
    expect(row.likes).toBe(89);
    expect(row.rating_avg).toBe(4.5);
    expect(row.rating_count).toBe(20);
    expect(row.created_at).toBe('2024-12-01T00:00:00.000Z');
  });

  it('uses alternate field names as fallbacks', () => {
    const doc = {
      releaseName: 'Alt Title',
      artist: 'Alt Artist',
      artworkUrl: '/alt-art.jpg',
      price: 5.99,
      playCount: 100,
      downloadCount: 50,
      viewCount: 200,
      likeCount: 10,
      overallRating: { average: 3.0, count: 5 },
      uploadedAt: '2024-06-01T00:00:00.000Z',
    };

    const row = releaseToD1Row('rel_alt', doc);

    expect(row.title).toBe('Alt Title');
    expect(row.artist_name).toBe('Alt Artist');
    expect(row.cover_url).toBe('/alt-art.jpg');
    expect(row.price_per_sale).toBe(5.99);
    expect(row.plays).toBe(100);
    expect(row.downloads).toBe(50);
    expect(row.views).toBe(200);
    expect(row.likes).toBe(10);
    expect(row.rating_avg).toBe(3.0);
    expect(row.rating_count).toBe(5);
    expect(row.created_at).toBe('2024-06-01T00:00:00.000Z');
  });

  it('handles missing/null fields with sensible defaults', () => {
    const doc = {};
    const row = releaseToD1Row('rel_empty', doc);

    expect(row.id).toBe('rel_empty');
    expect(row.title).toBe('Untitled');
    expect(row.artist_name).toBe('Unknown Artist');
    expect(row.genre).toBe('Jungle & D&B');
    expect(row.release_date).toBeNull();
    expect(row.status).toBe('pending');
    expect(row.published).toBe(0);
    expect(row.price_per_sale).toBe(0);
    expect(row.track_price).toBe(0);
    expect(row.vinyl_price).toBeNull();
    expect(row.vinyl_stock).toBe(0);
    expect(row.cover_url).toBeNull();
    expect(row.plays).toBe(0);
    expect(row.downloads).toBe(0);
    expect(row.views).toBe(0);
    expect(row.likes).toBe(0);
    expect(row.rating_avg).toBe(0);
    expect(row.rating_count).toBe(0);
  });

  it('marks as published when status is "published" even if published field is false', () => {
    const doc = { status: 'published', published: false };
    // Logic: (doc.published || doc.status === 'published')
    const row = releaseToD1Row('rel_pub', doc);
    expect(row.published).toBe(1);
  });

  it('marks as unpublished when neither published nor status===published', () => {
    const doc = { status: 'draft', published: false };
    const row = releaseToD1Row('rel_draft', doc);
    expect(row.published).toBe(0);
  });

  it('stores full JSON document in data field', () => {
    const doc = { title: 'Test', extra: 'data', nested: { key: 'val' } };
    const row = releaseToD1Row('rel_data', doc);
    const parsed = JSON.parse(row.data!);
    expect(parsed.title).toBe('Test');
    expect(parsed.extra).toBe('data');
    expect(parsed.nested.key).toBe('val');
  });

  it('uses imageUrl as fallback for cover', () => {
    const doc = { imageUrl: '/images/cover.jpg' };
    const row = releaseToD1Row('rel_img', doc);
    expect(row.cover_url).toBe('/images/cover.jpg');
    expect(row.thumb_url).toBe('/images/cover.jpg');
  });

  it('sets updated_at to current time', () => {
    const before = new Date().toISOString();
    const row = releaseToD1Row('rel_time', {});
    const after = new Date().toISOString();
    expect(row.updated_at).toBeTruthy();
    expect(row.updated_at! >= before).toBe(true);
    expect(row.updated_at! <= after).toBe(true);
  });
});

// =============================================
// d1RowToRelease
// =============================================
describe('d1RowToRelease', () => {
  it('parses data JSON and sets id from row', () => {
    const row = {
      id: 'rel_123',
      data: JSON.stringify({ title: 'Test Release', genre: 'Jungle' }),
    } as any;

    const doc = d1RowToRelease(row);
    expect(doc.id).toBe('rel_123');
    expect(doc.title).toBe('Test Release');
    expect(doc.genre).toBe('Jungle');
  });

  it('overrides id in data with row id', () => {
    const row = {
      id: 'correct_id',
      data: JSON.stringify({ id: 'wrong_id', title: 'Test' }),
    } as any;

    const doc = d1RowToRelease(row);
    expect(doc.id).toBe('correct_id');
  });

  it('returns null for invalid JSON', () => {
    const row = { id: 'bad', data: 'not json' } as any;
    expect(d1RowToRelease(row)).toBeNull();
  });
});

// =============================================
// merchToD1Row
// =============================================
describe('merchToD1Row', () => {
  it('maps all fields correctly', () => {
    const doc = {
      name: 'Fresh Wax T-Shirt',
      type: 'apparel',
      price: 24.99,
      totalStock: 100,
      reservedStock: 5,
      published: true,
      imageUrl: '/merch/tshirt.jpg',
      createdAt: '2024-11-01T00:00:00.000Z',
    };

    const row = merchToD1Row('merch_1', doc);

    expect(row.id).toBe('merch_1');
    expect(row.name).toBe('Fresh Wax T-Shirt');
    expect(row.type).toBe('apparel');
    expect(row.price).toBe(24.99);
    expect(row.stock).toBe(95); // 100 - 5 reserved
    expect(row.published).toBe(1);
    expect(row.image_url).toBe('/merch/tshirt.jpg');
    expect(row.created_at).toBe('2024-11-01T00:00:00.000Z');
  });

  it('deducts reserved stock from total stock', () => {
    const doc = { totalStock: 50, reservedStock: 10 };
    const row = merchToD1Row('merch_res', doc);
    expect(row.stock).toBe(40);
  });

  it('clamps stock to zero when reserved exceeds total', () => {
    const doc = { totalStock: 5, reservedStock: 10 };
    const row = merchToD1Row('merch_neg', doc);
    expect(row.stock).toBe(0); // Math.max(0, 5 - 10)
  });

  it('handles zero stock', () => {
    const doc = { totalStock: 0, reservedStock: 0 };
    const row = merchToD1Row('merch_zero', doc);
    expect(row.stock).toBe(0);
  });

  it('handles missing stock fields', () => {
    const doc = {};
    const row = merchToD1Row('merch_nostock', doc);
    expect(row.stock).toBe(0);
  });

  it('uses alternate field names: title, category, stock, quantity', () => {
    const doc = {
      title: 'Alt Merch',
      category: 'accessories',
      stock: 25,
    };
    const row = merchToD1Row('merch_alt', doc);
    expect(row.name).toBe('Alt Merch');
    expect(row.type).toBe('accessories');
    expect(row.stock).toBe(25);
  });

  it('handles null fields gracefully', () => {
    const doc = {
      name: null,
      type: null,
      price: null,
      imageUrl: null,
    };
    const row = merchToD1Row('merch_null', doc);
    expect(row.name).toBe('Untitled');
    expect(row.type).toBeNull();
    expect(row.price).toBe(0);
    expect(row.image_url).toBeNull();
  });

  it('extracts image URL from string', () => {
    const doc = { imageUrl: '/img/item.jpg' };
    const row = merchToD1Row('merch_img_str', doc);
    expect(row.image_url).toBe('/img/item.jpg');
  });

  it('extracts image URL from object with url property', () => {
    const doc = { imageUrl: { url: '/img/item.jpg', alt: 'Item' } };
    const row = merchToD1Row('merch_img_obj', doc);
    expect(row.image_url).toBe('/img/item.jpg');
  });

  it('extracts image URL from images array', () => {
    const doc = { images: ['/img/first.jpg', '/img/second.jpg'] };
    const row = merchToD1Row('merch_img_arr', doc);
    expect(row.image_url).toBe('/img/first.jpg');
  });

  it('extracts image URL from images array of objects', () => {
    const doc = { images: [{ url: '/img/first.jpg' }] };
    const row = merchToD1Row('merch_img_arr_obj', doc);
    expect(row.image_url).toBe('/img/first.jpg');
  });

  it('defaults published to true when not specified', () => {
    const doc = {};
    const row = merchToD1Row('merch_pub', doc);
    // Logic: (doc.published ?? doc.active ?? true) ? 1 : 0
    expect(row.published).toBe(1);
  });

  it('marks unpublished when published is false', () => {
    const doc = { published: false };
    const row = merchToD1Row('merch_unpub', doc);
    expect(row.published).toBe(0);
  });

  it('uses active field as fallback for published', () => {
    const doc = { active: false };
    const row = merchToD1Row('merch_inactive', doc);
    expect(row.published).toBe(0);
  });

  it('stores full JSON in data field', () => {
    const doc = { name: 'Test', customField: 'custom' };
    const row = merchToD1Row('merch_json', doc);
    const parsed = JSON.parse(row.data!);
    expect(parsed.name).toBe('Test');
    expect(parsed.customField).toBe('custom');
  });
});

// =============================================
// d1RowToMerch
// =============================================
describe('d1RowToMerch', () => {
  it('parses data JSON and sets id from row', () => {
    const row = {
      id: 'merch_1',
      data: JSON.stringify({ name: 'T-Shirt', price: 20 }),
    } as any;

    const doc = d1RowToMerch(row);
    expect(doc.id).toBe('merch_1');
    expect(doc.name).toBe('T-Shirt');
    expect(doc.price).toBe(20);
  });

  it('returns null for invalid JSON', () => {
    expect(d1RowToMerch({ id: 'bad', data: '{invalid' } as any)).toBeNull();
  });
});

// =============================================
// mixToD1Row
// =============================================
describe('mixToD1Row', () => {
  it('maps all fields correctly from a complete mix document', () => {
    const doc = {
      title: 'Summer Mix 2025',
      displayName: 'DJ Freshness',
      userId: 'user_456',
      genre: 'D&B',
      published: true,
      artworkUrl: '/mixes/art.jpg',
      audioUrl: '/mixes/audio.mp3',
      playCount: 500,
      downloadCount: 100,
      likeCount: 75,
      durationSeconds: 3600,
      uploadedAt: '2025-06-01T00:00:00.000Z',
    };

    const row = mixToD1Row('mix_1', doc);

    expect(row.id).toBe('mix_1');
    expect(row.title).toBe('Summer Mix 2025');
    expect(row.dj_name).toBe('DJ Freshness');
    expect(row.user_id).toBe('user_456');
    expect(row.genre).toBe('D&B');
    expect(row.published).toBe(1);
    expect(row.artwork_url).toBe('/mixes/art.jpg');
    expect(row.audio_url).toBe('/mixes/audio.mp3');
    expect(row.plays).toBe(500);
    expect(row.downloads).toBe(100);
    expect(row.likes).toBe(75);
    expect(row.duration_seconds).toBe(3600);
    expect(row.upload_date).toBe('2025-06-01T00:00:00.000Z');
  });

  it('uses alternate field names as fallbacks', () => {
    const doc = {
      name: 'Alt Mix',
      dj_name: 'Alt DJ',
      user_id: 'user_alt',
      genres: 'Jungle',
      artwork_url: '/alt-art.jpg',
      mp3Url: '/alt-audio.mp3',
      plays: 200,
      downloads: 50,
      likes: 25,
      duration_seconds: 1800,
      upload_date: '2025-03-01T00:00:00.000Z',
    };

    const row = mixToD1Row('mix_alt', doc);

    expect(row.title).toBe('Alt Mix');
    expect(row.dj_name).toBe('Alt DJ');
    expect(row.genre).toBe('Jungle');
    expect(row.audio_url).toBe('/alt-audio.mp3');
  });

  it('handles missing fields with sensible defaults', () => {
    const doc = {};
    const row = mixToD1Row('mix_empty', doc);

    expect(row.title).toBe('Untitled Mix');
    expect(row.dj_name).toBe('Unknown DJ');
    expect(row.user_id).toBeNull();
    expect(row.genre).toBe('Jungle & D&B');
    expect(row.artwork_url).toBeNull();
    expect(row.audio_url).toBeNull();
    expect(row.plays).toBe(0);
    expect(row.downloads).toBe(0);
    expect(row.likes).toBe(0);
    expect(row.duration_seconds).toBeNull();
    expect(row.upload_date).toBeNull();
  });

  it('stores JSON data in data field', () => {
    const doc = { title: 'Test Mix', custom: true };
    const row = mixToD1Row('mix_json', doc);
    const parsed = JSON.parse(row.data!);
    expect(parsed.title).toBe('Test Mix');
    expect(parsed.custom).toBe(true);
  });
});

// =============================================
// d1RowToMix
// =============================================
describe('d1RowToMix', () => {
  it('parses data JSON and sets id from row', () => {
    const row = {
      id: 'mix_1',
      data: JSON.stringify({ title: 'Test Mix', dj_name: 'DJ Test' }),
    } as any;

    const doc = d1RowToMix(row);
    expect(doc.id).toBe('mix_1');
    expect(doc.title).toBe('Test Mix');
  });

  it('returns null for invalid JSON', () => {
    expect(d1RowToMix({ id: 'bad', data: 'broken' } as any)).toBeNull();
  });
});

// =============================================
// slotToD1Row
// =============================================
describe('slotToD1Row', () => {
  it('maps all fields correctly', () => {
    const doc = {
      djId: 'dj_1',
      djName: 'DJ Test',
      title: 'Friday Night Set',
      genre: 'Jungle',
      status: 'live',
      startTime: '2025-06-01T20:00:00.000Z',
      endTime: '2025-06-01T22:00:00.000Z',
      streamKey: 'sk_123',
      hlsUrl: 'https://stream.example.com/live.m3u8',
      isRelay: true,
      relayStationId: 'station_1',
    };

    const row = slotToD1Row('slot_1', doc);

    expect(row.id).toBe('slot_1');
    expect(row.dj_id).toBe('dj_1');
    expect(row.dj_name).toBe('DJ Test');
    expect(row.title).toBe('Friday Night Set');
    expect(row.genre).toBe('Jungle');
    expect(row.status).toBe('live');
    expect(row.start_time).toBe('2025-06-01T20:00:00.000Z');
    expect(row.end_time).toBe('2025-06-01T22:00:00.000Z');
    expect(row.stream_key).toBe('sk_123');
    expect(row.hls_url).toBe('https://stream.example.com/live.m3u8');
    expect(row.is_relay).toBe(1);
    expect(row.relay_station_id).toBe('station_1');
  });

  it('handles missing fields with defaults', () => {
    const doc = {};
    const row = slotToD1Row('slot_empty', doc);

    expect(row.dj_id).toBeNull();
    expect(row.dj_name).toBe('Unknown DJ');
    expect(row.title).toBeNull();
    expect(row.genre).toBeNull();
    expect(row.status).toBe('scheduled');
    expect(row.stream_key).toBeNull();
    expect(row.hls_url).toBeNull();
    expect(row.is_relay).toBe(0);
    expect(row.relay_station_id).toBeNull();
  });

  it('uses alternate field names (userId, displayName)', () => {
    const doc = {
      userId: 'user_alt',
      displayName: 'Alt DJ Name',
      start_time: '2025-06-01T18:00:00.000Z',
      end_time: '2025-06-01T20:00:00.000Z',
    };
    const row = slotToD1Row('slot_alt', doc);
    expect(row.dj_id).toBe('user_alt');
    expect(row.dj_name).toBe('Alt DJ Name');
    expect(row.start_time).toBe('2025-06-01T18:00:00.000Z');
  });

  it('stores JSON in data field', () => {
    const doc = { djName: 'Test DJ', customField: 42 };
    const row = slotToD1Row('slot_json', doc);
    const parsed = JSON.parse(row.data!);
    expect(parsed.djName).toBe('Test DJ');
    expect(parsed.customField).toBe(42);
  });
});

// =============================================
// d1RowToSlot
// =============================================
describe('d1RowToSlot', () => {
  it('parses data JSON and sets id from row', () => {
    const row = {
      id: 'slot_1',
      data: JSON.stringify({ djName: 'DJ Test', status: 'live' }),
    } as any;

    const doc = d1RowToSlot(row);
    expect(doc.id).toBe('slot_1');
    expect(doc.djName).toBe('DJ Test');
  });

  it('returns null for invalid JSON', () => {
    expect(d1RowToSlot({ id: 'bad', data: 'broken' } as any)).toBeNull();
  });
});

// =============================================
// ledgerToD1Row
// =============================================
describe('ledgerToD1Row', () => {
  it('maps all fields from a complete ledger entry', () => {
    const entry = {
      id: 'led_1',
      orderId: 'ord_123',
      orderNumber: 'FW-250101-ABC123',
      timestamp: '2025-01-01T12:00:00.000Z',
      year: 2025,
      month: 1,
      day: 1,
      customerId: 'cust_1',
      customerEmail: 'customer@example.com',
      artistId: 'artist_1',
      artistName: 'DJ Test',
      submitterId: 'sub_1',
      submitterEmail: 'sub@example.com',
      subtotal: 25.00,
      shipping: 3.99,
      discount: 5.00,
      grossTotal: 23.99,
      stripeFee: 0.99,
      paypalFee: 0,
      freshWaxFee: 2.40,
      totalFees: 3.39,
      netRevenue: 20.60,
      artistPayout: 15.00,
      artistPayoutStatus: 'pending',
      paymentMethod: 'stripe',
      paymentId: 'pi_123',
      currency: 'GBP',
      itemCount: 3,
      hasPhysical: true,
      hasDigital: true,
      correctedAt: null,
    };

    const row = ledgerToD1Row(entry);

    expect(row.id).toBe('led_1');
    expect(row.order_id).toBe('ord_123');
    expect(row.order_number).toBe('FW-250101-ABC123');
    expect(row.timestamp).toBe('2025-01-01T12:00:00.000Z');
    expect(row.year).toBe(2025);
    expect(row.month).toBe(1);
    expect(row.day).toBe(1);
    expect(row.customer_id).toBe('cust_1');
    expect(row.customer_email).toBe('customer@example.com');
    expect(row.artist_id).toBe('artist_1');
    expect(row.artist_name).toBe('DJ Test');
    expect(row.submitter_id).toBe('sub_1');
    expect(row.submitter_email).toBe('sub@example.com');
    expect(row.subtotal).toBe(25.00);
    expect(row.shipping).toBe(3.99);
    expect(row.discount).toBe(5.00);
    expect(row.gross_total).toBe(23.99);
    expect(row.stripe_fee).toBe(0.99);
    expect(row.paypal_fee).toBe(0);
    expect(row.freshwax_fee).toBe(2.40);
    expect(row.total_fees).toBe(3.39);
    expect(row.net_revenue).toBe(20.60);
    expect(row.artist_payout).toBe(15.00);
    expect(row.artist_payout_status).toBe('pending');
    expect(row.payment_method).toBe('stripe');
    expect(row.payment_id).toBe('pi_123');
    expect(row.currency).toBe('GBP');
    expect(row.item_count).toBe(3);
    expect(row.has_physical).toBe(1);
    expect(row.has_digital).toBe(1);
    expect(row.corrected_at).toBeNull();
  });

  it('handles missing fields with defaults', () => {
    const entry = {
      id: 'led_empty',
      orderId: 'ord_1',
      orderNumber: 'FW-250101-XYZ',
      timestamp: '2025-01-01T00:00:00.000Z',
      year: 2025,
      month: 1,
      day: 1,
      customerEmail: 'c@e.com',
    };

    const row = ledgerToD1Row(entry);

    expect(row.customer_id).toBeNull();
    expect(row.artist_id).toBeNull();
    expect(row.artist_name).toBeNull();
    expect(row.submitter_id).toBeNull();
    expect(row.submitter_email).toBeNull();
    expect(row.subtotal).toBe(0);
    expect(row.shipping).toBe(0);
    expect(row.discount).toBe(0);
    expect(row.gross_total).toBe(0);
    expect(row.stripe_fee).toBe(0);
    expect(row.paypal_fee).toBe(0);
    expect(row.freshwax_fee).toBe(0);
    expect(row.total_fees).toBe(0);
    expect(row.net_revenue).toBe(0);
    expect(row.artist_payout).toBe(0);
    expect(row.artist_payout_status).toBe('pending');
    expect(row.payment_method).toBe('stripe');
    expect(row.payment_id).toBeNull();
    expect(row.currency).toBe('GBP');
    expect(row.item_count).toBe(0);
    expect(row.has_physical).toBe(0);
    expect(row.has_digital).toBe(0);
  });

  it('derives item_count from items array length when itemCount is missing', () => {
    const entry = {
      id: 'led_items',
      orderId: 'ord_1',
      orderNumber: 'FW-1',
      timestamp: '2025-01-01T00:00:00Z',
      year: 2025,
      month: 1,
      day: 1,
      customerEmail: 'c@e.com',
      items: [{}, {}, {}], // 3 items
    };

    const row = ledgerToD1Row(entry);
    expect(row.item_count).toBe(3);
  });

  it('stores full entry as JSON in data field', () => {
    const entry = {
      id: 'led_json',
      orderId: 'ord_1',
      orderNumber: 'FW-1',
      timestamp: '2025-01-01T00:00:00Z',
      year: 2025,
      month: 1,
      day: 1,
      customerEmail: 'c@e.com',
      customField: 'test',
    };

    const row = ledgerToD1Row(entry);
    const parsed = JSON.parse(row.data!);
    expect(parsed.customField).toBe('test');
  });
});

// =============================================
// d1RowToLedger
// =============================================
describe('d1RowToLedger', () => {
  it('parses data JSON and applies overrides from row columns', () => {
    const row = {
      id: 'led_1',
      data: JSON.stringify({ orderId: 'ord_1', netRevenue: 20 }),
      artist_payout_status: 'paid',
      artist_payout: 15,
    } as any;

    const doc = d1RowToLedger(row);
    expect(doc.id).toBe('led_1');
    expect(doc.orderId).toBe('ord_1');
    expect(doc.artistPayoutStatus).toBe('paid');
    expect(doc.artistPayout).toBe(15);
  });

  it('returns null for invalid JSON', () => {
    expect(
      d1RowToLedger({ id: 'bad', data: 'broken', artist_payout_status: 'pending', artist_payout: 0 } as any)
    ).toBeNull();
  });
});

// =============================================
// vinylSellerToD1Row
// =============================================
describe('vinylSellerToD1Row', () => {
  it('maps all fields correctly', () => {
    const doc = {
      storeName: 'Vinyl Paradise',
      location: 'London',
      description: 'Rare jungle vinyl',
      discogsUrl: 'https://discogs.com/seller/vp',
      shippingSingle: 3.50,
      shippingAdditional: 1.50,
      shipsInternational: true,
      shippingEurope: 8.00,
      shippingEuropeAdditional: 3.00,
      shippingWorldwide: 15.00,
      shippingWorldwideAdditional: 5.00,
    };

    const row = vinylSellerToD1Row('seller_1', doc);

    expect(row.id).toBe('seller_1');
    expect(row.store_name).toBe('Vinyl Paradise');
    expect(row.location).toBe('London');
    expect(row.description).toBe('Rare jungle vinyl');
    expect(row.discogs_url).toBe('https://discogs.com/seller/vp');
    expect(row.shipping_single).toBe(3.50);
    expect(row.shipping_additional).toBe(1.50);
    expect(row.ships_international).toBe(1);
    expect(row.shipping_europe).toBe(8.00);
    expect(row.shipping_europe_additional).toBe(3.00);
    expect(row.shipping_worldwide).toBe(15.00);
    expect(row.shipping_worldwide_additional).toBe(5.00);
  });

  it('handles missing fields with defaults', () => {
    const doc = {};
    const row = vinylSellerToD1Row('seller_empty', doc);

    expect(row.store_name).toBeNull();
    expect(row.location).toBeNull();
    expect(row.description).toBeNull();
    expect(row.discogs_url).toBeNull();
    expect(row.shipping_single).toBe(0);
    expect(row.shipping_additional).toBe(0);
    expect(row.ships_international).toBe(0);
    expect(row.shipping_europe).toBe(0);
    expect(row.shipping_europe_additional).toBe(0);
    expect(row.shipping_worldwide).toBe(0);
    expect(row.shipping_worldwide_additional).toBe(0);
  });
});

// =============================================
// d1RowToVinylSeller
// =============================================
describe('d1RowToVinylSeller', () => {
  it('parses data JSON and sets id and userId from row', () => {
    const row = {
      id: 'seller_1',
      data: JSON.stringify({ storeName: 'Test Store' }),
    } as any;

    const doc = d1RowToVinylSeller(row);
    expect(doc.id).toBe('seller_1');
    expect(doc.userId).toBe('seller_1');
    expect(doc.storeName).toBe('Test Store');
  });

  it('returns null for invalid JSON', () => {
    expect(d1RowToVinylSeller({ id: 'bad', data: 'nope' } as any)).toBeNull();
  });
});

// =============================================
// Round-trip tests: toD1Row -> rowToDoc
// =============================================
describe('round-trip transformations', () => {
  it('release round-trip preserves core data', () => {
    const originalDoc = {
      title: 'Jungle Fever',
      artistName: 'MC Test',
      genre: 'Jungle',
      published: true,
      plays: 500,
    };

    const row = releaseToD1Row('rt_release', originalDoc);
    const reconstructed = d1RowToRelease(row as any);

    expect(reconstructed.id).toBe('rt_release');
    expect(reconstructed.title).toBe('Jungle Fever');
    expect(reconstructed.artistName).toBe('MC Test');
    expect(reconstructed.plays).toBe(500);
  });

  it('merch round-trip preserves core data', () => {
    const originalDoc = {
      name: 'Hoodie',
      price: 39.99,
      totalStock: 50,
      reservedStock: 5,
    };

    const row = merchToD1Row('rt_merch', originalDoc);
    const reconstructed = d1RowToMerch(row as any);

    expect(reconstructed.id).toBe('rt_merch');
    expect(reconstructed.name).toBe('Hoodie');
    expect(reconstructed.price).toBe(39.99);
  });

  it('mix round-trip preserves core data', () => {
    const originalDoc = {
      title: 'Sunset Mix',
      displayName: 'DJ Sunset',
      playCount: 300,
    };

    const row = mixToD1Row('rt_mix', originalDoc);
    const reconstructed = d1RowToMix(row as any);

    expect(reconstructed.id).toBe('rt_mix');
    expect(reconstructed.title).toBe('Sunset Mix');
    expect(reconstructed.displayName).toBe('DJ Sunset');
  });
});
