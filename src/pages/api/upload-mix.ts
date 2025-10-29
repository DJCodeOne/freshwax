// src/pages/api/upload-mix.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const config = {
  // Increase body size limit to 500MB
  api: {
    bodyParser: {
      sizeLimit: '500mb',
    },
  },
};

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log('=== Upload Started ===');
    
    const formData = await request.formData();
    
    const audioFile = formData.get('audioFile') as File;
    const artworkFile = formData.get('artworkFile') as File | null;
    const djName = formData.get('djName') as string;
    const mixTitle = formData.get('mixTitle') as string;
    const mixDescription = formData.get('mixDescription') as string || '';

    console.log('Form data:', { 
      djName, 
      mixTitle, 
      audioSize: audioFile?.size,
      audioSizeMB: (audioFile?.size / 1024 / 1024).toFixed(2) + ' MB'
    });

    if (!audioFile || !djName || !mixTitle) {
      console.error('Missing required fields');
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    const timestamp = Date.now();
    const sanitizedDjName = djName.replace(/[^a-zA-Z0-9]/g, '_');
    const sanitizedMixTitle = mixTitle.replace(/[^a-zA-Z0-9]/g, '_');
    const mixId = `${sanitizedDjName}_${sanitizedMixTitle}_${timestamp}`;
    const folderPath = `dj-mixes/${mixId}`;

    console.log('Uploading audio...');
    console.log('Audio file size:', (audioFile.size / 1024 / 1024).toFixed(2), 'MB');

    // For large files (>10MB), we need to handle them differently
    const audioBuffer = await audioFile.arrayBuffer();
    const audioBytes = Buffer.from(audioBuffer);
    
    // Use Cloudinary's unsigned upload with larger timeout and chunk size
    const audioUploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: folderPath,
          public_id: 'audio',
          overwrite: false,
          chunk_size: 6000000, // 6MB chunks
          timeout: 600000, // 10 minute timeout
        },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            resolve(result);
          }
        }
      );

      // Write the buffer to the stream
      uploadStream.end(audioBytes);
    });

    console.log('Audio uploaded:', audioUploadResult.secure_url);

    // Handle artwork
    let artworkUrl: string;
    let artworkPublicId: string;

    if (artworkFile && artworkFile.size > 0) {
      console.log('Uploading artwork...');
      
      const artworkBuffer = await artworkFile.arrayBuffer();
      const artworkBytes = Buffer.from(artworkBuffer);

      const artworkUploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            folder: folderPath,
            public_id: 'artwork',
            overwrite: false,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(artworkBytes);
      });

      artworkUrl = artworkUploadResult.secure_url;
      artworkPublicId = artworkUploadResult.public_id;
      console.log('Artwork uploaded:', artworkUrl);
    } else {
      console.log('Using logo placeholder');
      artworkUrl = '/logo.webp';
      artworkPublicId = 'placeholder_logo';
    }

    const mixMetadata = {
      id: mixId,
      dj_name: djName,
      title: mixTitle,
      description: mixDescription,
      audio_url: audioUploadResult.secure_url,
      artwork_url: artworkUrl,
      upload_date: new Date().toISOString(),
      folder_path: folderPath,
      audio_public_id: audioUploadResult.public_id,
      artwork_public_id: artworkPublicId,
    };

    console.log('Fetching existing mixes...');

    // Get existing mixes list
    let mixesList = [];
    
    try {
      const info = await cloudinary.api.resource('dj-mixes/mixes.json', {
        resource_type: 'raw'
      });
      
      const currentVersion = info.version;
      console.log('Current mixes.json version:', currentVersion);
      
      const mixesUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${currentVersion}/dj-mixes/mixes.json`;
      const response = await fetch(mixesUrl);
      
      if (response.ok) {
        mixesList = await response.json();
        console.log('Loaded existing mixes:', mixesList.length);
      }
    } catch (e) {
      console.log('No existing mixes list found, creating new one');
    }

    // Add new mix at the beginning
    mixesList.unshift(mixMetadata);

    console.log('Uploading updated mixes.json...');

    const mixesListJson = JSON.stringify(mixesList, null, 2);
    const mixesListBytes = Buffer.from(mixesListJson);

    const mixesUploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          public_id: 'dj-mixes/mixes.json',
          use_filename: true,
          unique_filename: false,
          overwrite: true,
          invalidate: true,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(mixesListBytes);
    });

    console.log('Mixes list uploaded');
    console.log('New version URL:', mixesUploadResult.secure_url);
    
    const versionMatch = mixesUploadResult.secure_url.match(/\/v(\d+)\//);
    const newVersion = versionMatch ? versionMatch[1] : null;
    
    console.log('New mixes.json version:', newVersion);

    // Upload metadata
    console.log('Uploading metadata...');
    const metadataJson = JSON.stringify(mixMetadata, null, 2);
    const metadataBytes = Buffer.from(metadataJson);

    await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: folderPath,
          public_id: 'metadata',
          overwrite: false,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(metadataBytes);
    });

    console.log('=== Upload Complete ===');

    return new Response(JSON.stringify({
      success: true,
      message: 'Mix uploaded and published successfully',
      mixId,
      mix: mixMetadata,
      mixesJsonUrl: mixesUploadResult.secure_url,
      mixesJsonVersion: newVersion,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('=== Upload Error ===');
    console.error(error);
    
    return new Response(JSON.stringify({
      error: 'Failed to upload mix',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};