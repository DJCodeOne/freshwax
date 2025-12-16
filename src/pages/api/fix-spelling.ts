// Fix spelling in submission metadata
import type { APIRoute } from 'astro';
import { AwsClient } from 'aws4fetch';

function getR2Config(env: any) {
  return {
    accountId: env?.R2_ACCOUNT_ID || import.meta.env.R2_ACCOUNT_ID,
    accessKeyId: env?.R2_ACCESS_KEY_ID || import.meta.env.R2_ACCESS_KEY_ID,
    secretAccessKey: env?.R2_SECRET_ACCESS_KEY || import.meta.env.R2_SECRET_ACCESS_KEY,
    bucketName: 'freshwax-releases',
  };
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = (locals as any)?.runtime?.env;
    const R2_CONFIG = getR2Config(env);

    const awsClient = new AwsClient({
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`;
    const bucketUrl = `${endpoint}/${R2_CONFIG.bucketName}`;

    const metadataKey = 'submissions/Code_One-1765771210267/metadata.json';
    const metadataUrl = `${bucketUrl}/${encodeURIComponent(metadataKey)}`;

    // Get current metadata
    const getResponse = await awsClient.fetch(metadataUrl);
    if (!getResponse.ok) {
      throw new Error('Failed to get metadata');
    }

    const metadata = await getResponse.json() as any;

    // Fix spelling: Conciousness -> Consciousness
    let fixed = false;

    if (metadata.trackListing) {
      metadata.trackListing = metadata.trackListing.replace(/Conciousness/g, 'Consciousness');
      fixed = true;
    }

    if (metadata.trackListingJSON) {
      metadata.trackListingJSON = metadata.trackListingJSON.replace(/Conciousness/g, 'Consciousness');
      fixed = true;
    }

    if (metadata.tracks && Array.isArray(metadata.tracks)) {
      for (const track of metadata.tracks) {
        if (track.title && track.title.includes('Conciousness')) {
          track.title = track.title.replace(/Conciousness/g, 'Consciousness');
          fixed = true;
        }
        if (track.trackName && track.trackName.includes('Conciousness')) {
          track.trackName = track.trackName.replace(/Conciousness/g, 'Consciousness');
          fixed = true;
        }
      }
    }

    if (!fixed) {
      return new Response(JSON.stringify({ message: 'No spelling issues found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Upload fixed metadata
    const putResponse = await awsClient.fetch(metadataUrl, {
      method: 'PUT',
      body: JSON.stringify(metadata, null, 2),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!putResponse.ok) {
      throw new Error('Failed to update metadata');
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Fixed spelling: Conciousness -> Consciousness',
      tracks: metadata.tracks
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
