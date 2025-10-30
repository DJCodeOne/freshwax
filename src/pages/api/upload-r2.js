// src/pages/api/upload-r2.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const prerender = false;

export async function POST({ request }) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const filename = formData.get('filename');
    const releaseId = formData.get('releaseId');
    
    if (!file || !filename) {
      return new Response(JSON.stringify({ error: 'Missing file or filename' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`Uploading ${filename} for release ${releaseId}`);

    // R2 Configuration
    const s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${import.meta.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
        secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
      },
    });

    // Convert file to buffer
    const buffer = await file.arrayBuffer();
    
    // Determine file path based on type
    let filePath;
    const ext = filename.split('.').pop().toLowerCase();
    
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      // Images go in covers folder
      filePath = `releases/${releaseId}/covers/${filename}`;
    } else if (['mp3', 'wav', 'flac'].includes(ext)) {
      // Audio files go in tracks folder
      filePath = `releases/${releaseId}/tracks/${filename}`;
    } else {
      // Other files go in the release folder
      filePath = `releases/${releaseId}/${filename}`;
    }

    console.log(`Uploading to path: ${filePath}`);

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: import.meta.env.R2_BUCKET_NAME,
      Key: filePath,
      Body: Buffer.from(buffer),
      ContentType: file.type || 'application/octet-stream',
    });

    await s3Client.send(command);

    // Return the public URL
    const publicUrl = `${import.meta.env.R2_PUBLIC_URL}/${filePath}`;

    console.log(`Upload successful: ${publicUrl}`);

    return new Response(JSON.stringify({ 
      url: publicUrl,
      path: filePath,
      filename: filename
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('R2 Upload error:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}