import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const prerender = false;

export async function POST({ request }) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const filename = formData.get('filename');
    const trackNumber = formData.get('trackNumber');
    
    // R2 Configuration
    const s3Client = new S3Client({
      region: "auto",
      endpoint: import.meta.env.R2_ENDPOINT, // e.g., https://your-account-id.r2.cloudflarestorage.com
      credentials: {
        accessKeyId: import.meta.env.R2_ACCESS_KEY_ID,
        secretAccessKey: import.meta.env.R2_SECRET_ACCESS_KEY,
      },
    });

    const buffer = await file.arrayBuffer();
    
    const command = new PutObjectCommand({
      Bucket: import.meta.env.R2_BUCKET_NAME,
      Key: `tracks/${filename}`,
      Body: Buffer.from(buffer),
      ContentType: file.type,
    });

    await s3Client.send(command);

    // Return the public URL
    const publicUrl = `${import.meta.env.R2_PUBLIC_URL}/tracks/${filename}`;

    return new Response(JSON.stringify({ url: publicUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}