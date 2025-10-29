// Try uploading as authenticated type to make versionless URL work
// Run with: node fix-mixes-final.cjs

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dscqbze0d',
  api_key: '555922422486159',
  api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
});

const mixesData = [
  {
    "id": "Code_One_single_track_1761619764795",
    "dj_name": "Code One",
    "title": "single track",
    "description": "",
    "audio_url": "https://res.cloudinary.com/dscqbze0d/video/upload/v1761619771/dj-mixes/Code_One_single_track_1761619764795/audio.mp3",
    "artwork_url": "https://res.cloudinary.com/dscqbze0d/image/upload/v1761619772/dj-mixes/Code_One_single_track_1761619764795/artwork.jpg",
    "upload_date": "2025-10-28T02:49:32.710Z",
    "folder_path": "dj-mixes/Code_One_single_track_1761619764795",
    "audio_public_id": "dj-mixes/Code_One_single_track_1761619764795/audio",
    "artwork_public_id": "dj-mixes/Code_One_single_track_1761619764795/artwork"
  }
];

async function tryDifferentApproaches() {
  const mixesJson = JSON.stringify(mixesData, null, 2);
  const dataUri = `data:application/json;base64,${Buffer.from(mixesJson).toString('base64')}`;
  
  console.log('🔧 Trying different upload approaches...\n');
  
  // Approach 1: Use upload type with use_filename
  try {
    console.log('📤 Approach 1: With use_filename...');
    const result1 = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'raw',
      public_id: 'dj-mixes/mixes.json',
      use_filename: true,
      unique_filename: false,
      overwrite: true,
      invalidate: true,
    });
    console.log('✅ Success!');
    console.log('   URL:', result1.secure_url);
    console.log('   Test: https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/mixes.json\n');
    return result1;
  } catch (e) {
    console.log('❌ Failed:', e.message, '\n');
  }
  
  // Approach 2: Try without folder prefix
  try {
    console.log('📤 Approach 2: Flat structure...');
    const result2 = await cloudinary.uploader.upload(dataUri, {
      resource_type: 'raw',
      public_id: 'mixes',
      folder: 'dj-mixes',
      overwrite: true,
      invalidate: true,
    });
    console.log('✅ Success!');
    console.log('   URL:', result2.secure_url);
    console.log('   Test: https://res.cloudinary.com/dscqbze0d/raw/upload/dj-mixes/mixes\n');
    return result2;
  } catch (e) {
    console.log('❌ Failed:', e.message, '\n');
  }
}

tryDifferentApproaches();
