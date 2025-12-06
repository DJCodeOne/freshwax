import { R2FirebaseSync } from '../../lib/r2-firebase-sync';
import * as fs from 'fs';
import * as path from 'path';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => isDev && console.warn(...args),
};

export const POST = async ({ request, locals }: any) => {
  try {
    log.info('[sync-release] Sync release API called');

    const formData = await request.formData();
    const zipFile = formData.get('zipFile');

    if (!zipFile) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'No ZIP file provided' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempZipPath = path.join(tempDir, 'upload-' + Date.now() + '.zip');
    const buffer = Buffer.from(await zipFile.arrayBuffer());
    fs.writeFileSync(tempZipPath, buffer);

    log.info('[sync-release] Saved ZIP to:', tempZipPath);

    const env = locals?.runtime?.env || {};
    const config = {
      r2: {
        accountId: env.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
        bucketName: env.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
        publicDomain: env.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN || 'https://cdn.freshwax.co.uk',
      },
      firebase: {
        projectId: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY,
        clientEmail: env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      },
      collections: {
        releases: 'releases',
        tracks: 'tracks',
      },
    };

    if (!config.r2.accountId || !config.r2.accessKeyId || !config.r2.secretAccessKey) {
      throw new Error('R2 credentials not configured');
    }
    if (!config.firebase.projectId || !config.firebase.privateKey || !config.firebase.clientEmail) {
      throw new Error('Firebase credentials not configured');
    }

    log.info('[sync-release] Configuration validated');

    const sync = new R2FirebaseSync(config);
    const releaseId = await sync.processPackageAndSync(tempZipPath);

    try {
      fs.unlinkSync(tempZipPath);
    } catch (e) {
      log.warn('[sync-release] Could not delete temp ZIP:', e);
    }

    log.info('[sync-release] Success:', releaseId);

    return new Response(JSON.stringify({
      success: true,
      releaseId,
      message: 'Release ' + releaseId + ' synced successfully',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    log.error('[sync-release] Sync failed:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Sync failed',
      details: error instanceof Error ? error.stack : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const GET = async ({ url, locals }: any) => {
  try {
    const env = locals?.runtime?.env || {};
    const config = {
      r2: {
        accountId: env.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
        bucketName: env.R2_RELEASES_BUCKET || import.meta.env.R2_RELEASES_BUCKET || 'freshwax-releases',
        publicDomain: env.R2_PUBLIC_DOMAIN || import.meta.env.R2_PUBLIC_DOMAIN,
      },
      firebase: {
        projectId: env.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY || import.meta.env.FIREBASE_PRIVATE_KEY,
        clientEmail: env.FIREBASE_CLIENT_EMAIL || import.meta.env.FIREBASE_CLIENT_EMAIL,
      },
      collections: {
        releases: 'releases',
        tracks: 'tracks',
      },
    };

    const sync = new R2FirebaseSync(config);
    
    const status = url.searchParams.get('status');
    const featured = url.searchParams.get('featured');
    const limit = url.searchParams.get('limit');
    
    const options: any = {};
    if (status) options.status = status;
    if (featured !== null) options.featured = featured === 'true';
    if (limit) options.limit = parseInt(limit);
    options.orderBy = 'publishedAt';
    options.order = 'desc';
    
    const releases = await sync.listReleases(options);

    log.info('[sync-release] Listed', releases.length, 'releases');

    return new Response(JSON.stringify({
      success: true,
      releases,
      count: releases.length,
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      }
    });

  } catch (error) {
    log.error('[sync-release] List releases failed:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list releases',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};