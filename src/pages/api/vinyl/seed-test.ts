// src/pages/api/vinyl/seed-test.ts
// TEMPORARY: Seed test vinyl listings for demonstration
// DELETE THIS FILE after testing

import type { APIRoute } from 'astro';
import { saSetDocument } from '../../../lib/firebase-service-account';

export const prerender = false;

// Test data - realistic vinyl record listings
const testListings = [
  {
    id: 'vl_test_goldie_timeless',
    sellerId: 'test_seller_001',
    sellerName: 'Classic Jungle Records',
    title: 'Timeless',
    artist: 'Goldie',
    label: 'FFRR',
    catalogNumber: '828 637-1',
    format: 'LP',
    releaseYear: 1995,
    genre: 'Jungle',
    mediaCondition: 'VG+',
    sleeveCondition: 'VG+',
    conditionNotes: 'Light surface marks on disc 1, plays through excellently. Sleeve has minor corner wear.',
    price: 45.00,
    originalPrice: 45.00,
    discountPercent: 0,
    dealType: 'none',
    dealDescription: '',
    shippingCost: 5.99,
    description: 'Original UK pressing of this landmark jungle/drum and bass album. Inner State of Mind and Angel are essential listening. This 3xLP set is in great condition for its age.',
    images: [
      '/place-holder.webp'
    ],
    tracks: [
      { position: 1, side: 'A', name: 'Timeless', audioSampleUrl: null, audioSampleDuration: null },
      { position: 2, side: 'A', name: 'Saint Angel', audioSampleUrl: null, audioSampleDuration: null },
      { position: 3, side: 'B', name: 'State of Mind', audioSampleUrl: null, audioSampleDuration: null },
      { position: 4, side: 'B', name: 'This Is A Bad', audioSampleUrl: null, audioSampleDuration: null },
      { position: 5, side: 'C', name: 'Jah', audioSampleUrl: null, audioSampleDuration: null },
      { position: 6, side: 'C', name: 'Angel', audioSampleUrl: null, audioSampleDuration: null },
      { position: 7, side: 'D', name: 'Sensual', audioSampleUrl: null, audioSampleDuration: null },
      { position: 8, side: 'D', name: 'Still Life', audioSampleUrl: null, audioSampleDuration: null }
    ],
    status: 'published',
    views: 234,
    saves: 12,
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'vl_test_ltj_bukem_logical',
    sellerId: 'test_seller_001',
    sellerName: 'Classic Jungle Records',
    title: 'Logical Progression',
    artist: 'LTJ Bukem',
    label: 'Good Looking Records',
    catalogNumber: 'GLRLP 001',
    format: 'LP',
    releaseYear: 1996,
    genre: 'Drum and Bass',
    mediaCondition: 'NM',
    sleeveCondition: 'VG+',
    conditionNotes: 'Beautiful copy, vinyl almost perfect. Slight ring wear on outer sleeve.',
    price: 52.00,
    originalPrice: 65.00,
    discountPercent: 20,
    dealType: 'percentage',
    dealDescription: '20% off this week!',
    shippingCost: 5.99,
    description: 'Essential atmospheric jungle compilation from the Good Looking camp. Features Horizons by LTJ Bukem, Kaotic Harmony by Peshay, and many more classics.',
    images: [
      '/place-holder.webp'
    ],
    tracks: [
      { position: 1, side: 'A', name: 'Horizons', audioSampleUrl: null, audioSampleDuration: null },
      { position: 2, side: 'A', name: 'Atlantis', audioSampleUrl: null, audioSampleDuration: null },
      { position: 3, side: 'B', name: 'Music', audioSampleUrl: null, audioSampleDuration: null },
      { position: 4, side: 'B', name: 'Kaotic Harmony', audioSampleUrl: null, audioSampleDuration: null }
    ],
    status: 'published',
    views: 156,
    saves: 8,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'vl_test_roni_size_reprazent',
    sellerId: 'test_seller_002',
    sellerName: 'Bristol Bass Vinyl',
    title: 'New Forms',
    artist: 'Roni Size / Reprazent',
    label: 'Talkin\' Loud',
    catalogNumber: '534 699-1',
    format: 'LP',
    releaseYear: 1997,
    genre: 'Drum and Bass',
    mediaCondition: 'VG+',
    sleeveCondition: 'VG',
    conditionNotes: 'Vinyl in excellent shape with minimal wear. Sleeve shows some age - creases and edge wear.',
    price: 35.00,
    originalPrice: 50.00,
    discountPercent: 30,
    dealType: 'clearance',
    dealDescription: 'Clearance - slight sleeve damage',
    shippingCost: 6.99,
    description: 'Mercury Prize winning album! A groundbreaking fusion of drum and bass with live instrumentation. Features Brown Paper Bag and Heroes.',
    images: [
      '/place-holder.webp'
    ],
    tracks: [
      { position: 1, side: 'A', name: 'Railing', audioSampleUrl: null, audioSampleDuration: null },
      { position: 2, side: 'A', name: 'Brown Paper Bag', audioSampleUrl: null, audioSampleDuration: null },
      { position: 3, side: 'B', name: 'New Forms', audioSampleUrl: null, audioSampleDuration: null },
      { position: 4, side: 'B', name: 'Let\'s Get It On', audioSampleUrl: null, audioSampleDuration: null },
      { position: 5, side: 'C', name: 'Digital', audioSampleUrl: null, audioSampleDuration: null },
      { position: 6, side: 'C', name: 'Matter of Fact', audioSampleUrl: null, audioSampleDuration: null },
      { position: 7, side: 'D', name: 'Heroes', audioSampleUrl: null, audioSampleDuration: null },
      { position: 8, side: 'D', name: 'Share the Fall', audioSampleUrl: null, audioSampleDuration: null }
    ],
    status: 'published',
    views: 89,
    saves: 5,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'vl_test_shy_fx_original',
    sellerId: 'test_seller_002',
    sellerName: 'Bristol Bass Vinyl',
    title: 'Original Nuttah / Gangsta Kid',
    artist: 'Shy FX & UK Apachi',
    label: 'Sound Of Underground London',
    catalogNumber: 'SOUR 008',
    format: '12"',
    releaseYear: 1994,
    genre: 'Jungle',
    mediaCondition: 'VG',
    sleeveCondition: 'VG',
    conditionNotes: 'Classic tune! Some visible wear but plays well. Generic white sleeve.',
    price: 28.00,
    originalPrice: 28.00,
    discountPercent: 0,
    dealType: 'none',
    dealDescription: '',
    shippingCost: 4.99,
    description: 'Massive jungle anthem! Original Nuttah is one of the most recognizable jungle tracks ever made. A must-have for any collection.',
    images: [
      '/place-holder.webp'
    ],
    tracks: [
      { position: 1, side: 'A', name: 'Original Nuttah', audioSampleUrl: null, audioSampleDuration: null },
      { position: 2, side: 'B', name: 'Gangsta Kid', audioSampleUrl: null, audioSampleDuration: null }
    ],
    status: 'published',
    views: 312,
    saves: 24,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'vl_test_photek_modus',
    sellerId: 'test_seller_003',
    sellerName: 'Darkside Wax',
    title: 'Modus Operandi',
    artist: 'Photek',
    label: 'Virgin',
    catalogNumber: 'V 2826',
    format: 'LP',
    releaseYear: 1997,
    genre: 'Drum and Bass',
    mediaCondition: 'NM',
    sleeveCondition: 'NM',
    conditionNotes: 'Pristine copy. Bought new and played only a handful of times. Stored properly.',
    price: 80.00,
    originalPrice: 80.00,
    discountPercent: 0,
    dealType: 'none',
    dealDescription: '',
    shippingCost: 6.99,
    description: 'One of the most technically innovative D&B albums ever. Features Ni Ten Ichi Ryu and The Hidden Camera. This copy is in exceptional condition.',
    images: [
      '/place-holder.webp'
    ],
    tracks: [
      { position: 1, side: 'A', name: 'Smoke Rings', audioSampleUrl: null, audioSampleDuration: null },
      { position: 2, side: 'A', name: 'Ni Ten Ichi Ryu', audioSampleUrl: null, audioSampleDuration: null },
      { position: 3, side: 'B', name: 'The Hidden Camera', audioSampleUrl: null, audioSampleDuration: null },
      { position: 4, side: 'B', name: 'Minotaur', audioSampleUrl: null, audioSampleDuration: null },
      { position: 5, side: 'C', name: 'Trans 7', audioSampleUrl: null, audioSampleDuration: null },
      { position: 6, side: 'C', name: 'KJZ', audioSampleUrl: null, audioSampleDuration: null },
      { position: 7, side: 'D', name: 'Consciousness', audioSampleUrl: null, audioSampleDuration: null },
      { position: 8, side: 'D', name: 'The Fifth Column', audioSampleUrl: null, audioSampleDuration: null }
    ],
    status: 'published',
    views: 78,
    saves: 6,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// Test seller data
const testSellers = [
  {
    id: 'test_seller_001',
    name: 'Classic Jungle Records',
    totalListings: 2,
    totalSales: 15,
    rating: 4.8,
    location: 'London, UK',
    createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'test_seller_002',
    name: 'Bristol Bass Vinyl',
    totalListings: 2,
    totalSales: 8,
    rating: 4.6,
    location: 'Bristol, UK',
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'test_seller_003',
    name: 'Darkside Wax',
    totalListings: 1,
    totalSales: 3,
    rating: 5.0,
    location: 'Manchester, UK',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// Get service account key from environment
function getServiceAccountKey(locals: any): string | null {
  const env = locals?.runtime?.env || {};

  // Try FIREBASE_SERVICE_ACCOUNT first, then FIREBASE_SERVICE_ACCOUNT_KEY
  let serviceAccountKey = env.FIREBASE_SERVICE_ACCOUNT || import.meta.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountKey) {
    serviceAccountKey = env.FIREBASE_SERVICE_ACCOUNT_KEY || import.meta.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  }

  // If individual vars are set, construct the key
  if (!serviceAccountKey) {
    const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID;
    const clientEmail = env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY;

    if (projectId && clientEmail && privateKey) {
      serviceAccountKey = JSON.stringify({
        type: 'service_account',
        project_id: projectId,
        private_key_id: 'auto',
        private_key: privateKey.replace(/\\n/g, '\n'),
        client_email: clientEmail,
        client_id: '',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token'
      });
    }
  }

  return serviceAccountKey || null;
}

export const GET: APIRoute = async ({ locals }) => {
  const serviceAccountKey = getServiceAccountKey(locals);
  const env = locals?.runtime?.env || {};
  const projectId = env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID || 'freshwax-store';

  if (!serviceAccountKey) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Service account not configured'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Create test sellers
    for (const seller of testSellers) {
      await saSetDocument(serviceAccountKey, projectId, 'vinylSellers', seller.id, seller);
    }

    // Create test listings
    for (const listing of testListings) {
      await saSetDocument(serviceAccountKey, projectId, 'vinylListings', listing.id, listing);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Test data seeded successfully',
      listings: testListings.length,
      sellers: testSellers.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[seed-test] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to seed test data',
      details: String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
