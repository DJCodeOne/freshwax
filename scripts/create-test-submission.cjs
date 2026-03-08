// Create a test submission in R2 that will appear in admin pending submissions
// Usage: node scripts/create-test-submission.cjs

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Read .env manually
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) envVars[match[1].trim()] = match[2].trim();
}

const accountId = envVars.R2_ACCOUNT_ID;
const accessKeyId = envVars.R2_ACCESS_KEY_ID;
const secretAccessKey = envVars.R2_SECRET_ACCESS_KEY;
const bucketName = envVars.R2_BUCKET_NAME || 'freshwax-releases';

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing R2 credentials in .env');
  process.exit(1);
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

async function main() {
  const timestamp = Date.now();
  const folder = `submissions/Test_Artist-${timestamp}`;

  console.log(`Creating test submission at: ${folder}/`);

  // 1. Create info.json with test metadata
  const infoJson = {
    artistName: 'Test Artist',
    releaseName: 'Test EP - Delete Me',
    genre: 'Drum and Bass',
    email: 'test@example.com',
    releaseDate: new Date().toISOString(),
    pricePerSale: 5.99,
    trackPrice: 1.49,
    copyrightYear: '2026',
    copyrightHolder: 'Test Artist',
    releaseDescription: 'This is a test submission to verify the upload flow.',
    tracks: [
      {
        trackNumber: 1,
        title: 'Test Track One',
        bpm: '174',
        key: 'F minor',
        duration: '240',
      },
      {
        trackNumber: 2,
        title: 'Test Track Two',
        bpm: '172',
        key: 'A minor',
        duration: '300',
      },
    ],
  };

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `${folder}/info.json`,
    Body: JSON.stringify(infoJson, null, 2),
    ContentType: 'application/json',
  }));
  console.log('  Uploaded info.json');

  // 2. Create a minimal valid WAV file (44 bytes header + 4 bytes silence = 48 bytes)
  // This is the smallest valid WAV: 1 sample of silence, 16-bit mono 44100Hz
  function createMinimalWav() {
    const buffer = Buffer.alloc(48);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(40, 4);      // File size - 8
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);     // fmt chunk size
    buffer.writeUInt16LE(1, 20);      // PCM format
    buffer.writeUInt16LE(1, 22);      // Mono
    buffer.writeUInt32LE(44100, 24);  // Sample rate
    buffer.writeUInt32LE(88200, 28);  // Byte rate
    buffer.writeUInt16LE(2, 32);      // Block align
    buffer.writeUInt16LE(16, 34);     // Bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(4, 40);      // Data size (2 samples)
    buffer.writeInt16LE(0, 44);       // Sample 1: silence
    buffer.writeInt16LE(0, 46);       // Sample 2: silence
    return buffer;
  }

  const wavData = createMinimalWav();

  // Upload two test audio files
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `${folder}/01_Test_Track_One.wav`,
    Body: wavData,
    ContentType: 'audio/wav',
  }));
  console.log('  Uploaded 01_Test_Track_One.wav');

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `${folder}/02_Test_Track_Two.wav`,
    Body: wavData,
    ContentType: 'audio/wav',
  }));
  console.log('  Uploaded 02_Test_Track_Two.wav');

  // 3. Create a small test cover image (1x1 red pixel JPEG)
  // Minimal JPEG: 1x1 pixel red
  const jpegHex = 'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc40000ffc40000ffda00080101000003100002000000017ffd9';
  const jpegData = Buffer.from(jpegHex, 'hex');

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `${folder}/cover.jpg`,
    Body: jpegData,
    ContentType: 'image/jpeg',
  }));
  console.log('  Uploaded cover.jpg');

  console.log(`\nTest submission created: ${folder}`);
  console.log('Check admin dashboard at /admin/releases/process/ to see it in pending submissions.');
  console.log(`\nTo clean up later: node -e "require('@aws-sdk/client-s3');..." or process+delete via admin.`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
