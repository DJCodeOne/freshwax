import type { APIRoute } from 'astro';
import { queryCollection, getDocument } from '../../lib/firebase-rest';

export const GET: APIRoute = async () => {
  const results: any = {
    timestamp: new Date().toISOString(),
    tests: {}
  };

  // Test 1: Query releases
  try {
    const releases = await queryCollection('releases', { limit: 3 });
    results.tests.releases = {
      success: true,
      count: releases.length,
      sample: releases[0] ? { id: releases[0].id, title: releases[0].title || releases[0].name } : null
    };
  } catch (error: any) {
    results.tests.releases = { success: false, error: error.message };
  }

  // Test 2: Query orders
  try {
    const orders = await queryCollection('orders', { limit: 3 });
    results.tests.orders = {
      success: true,
      count: orders.length
    };
  } catch (error: any) {
    results.tests.orders = { success: false, error: error.message };
  }

  // Test 3: Query merch
  try {
    const merch = await queryCollection('merch', { limit: 3 });
    results.tests.merch = {
      success: true,
      count: merch.length
    };
  } catch (error: any) {
    results.tests.merch = { success: false, error: error.message };
  }

  // Test 4: Query dj-mixes
  try {
    const mixes = await queryCollection('dj-mixes', { limit: 3 });
    results.tests.djMixes = {
      success: true,
      count: mixes.length
    };
  } catch (error: any) {
    results.tests.djMixes = { success: false, error: error.message };
  }

  // Test 5: Get a specific document
  try {
    const settings = await getDocument('settings', 'admin');
    results.tests.settings = {
      success: true,
      exists: !!settings,
      data: settings ? Object.keys(settings) : null
    };
  } catch (error: any) {
    results.tests.settings = { success: false, error: error.message };
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
};
