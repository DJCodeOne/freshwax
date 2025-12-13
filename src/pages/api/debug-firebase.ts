import { queryCollection, initFirebaseEnv } from '../../lib/firebase-rest';

// Conditional logging - only logs in development
const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

export const GET = async ({ locals }: any) => {
  try {
    // Initialize Firebase environment
    const env = locals?.runtime?.env || {};
    initFirebaseEnv({
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
      FIREBASE_API_KEY: env.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
    });

    log.info('🔍 Checking Firebase releases collection...');

    const releases = await queryCollection('releases', { skipCache: true });

    log.info('📊 Total documents:', releases.length);

    releases.forEach(release => {
      log.info('📄 Document ID:', release.id);
      log.info('📄 Document data:', JSON.stringify(release, null, 2));
    });

    return new Response(JSON.stringify({
      success: true,
      count: releases.length,
      releases: releases,
      collections: 'releases',
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('❌ Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack,
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};