// src/pages/api/save-release.js
// Saves releases as individual JSON files in src/data/releases/

export async function POST({ request }) {
  try {
    console.log('📥 Received publish request');
    
    // Get the raw text first to debug
    const rawBody = await request.text();
    console.log('📝 Raw body received, length:', rawBody.length);
    
    // Parse the request body
    let releaseData;
    try {
      releaseData = JSON.parse(rawBody);
      console.log('✅ Parsed JSON data successfully');
      console.log('📋 Release data keys:', Object.keys(releaseData));
    } catch (parseError) {
      console.error('❌ Failed to parse JSON:', parseError);
      console.error('❌ Raw body preview:', rawBody.substring(0, 500));
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid JSON in request body',
        details: parseError.message,
        preview: rawBody.substring(0, 200)
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate required fields
    if (!releaseData.id || !releaseData.title || !releaseData.artist) {
      console.error('❌ Missing required fields');
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: id, title, or artist',
        received: {
          id: releaseData.id,
          title: releaseData.title,
          artist: releaseData.artist
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dynamic import of fs and path (for Node.js environment)
    const fs = await import('fs/promises');
    const path = await import('path');
    console.log('✅ Imported fs and path modules');

    // Generate filename if not provided
    const filename = releaseData.filename || 
      `${releaseData.artist}-${releaseData.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    
    console.log('📝 Generated filename:', filename);

    // Path to save the individual release JSON file
    const releasesDir = path.join(process.cwd(), 'src', 'data', 'releases');
    const filePath = path.join(releasesDir, `${filename}.json`);
    
    console.log('📂 Target directory:', releasesDir);
    console.log('📄 Target file path:', filePath);

    // Ensure the directory exists
    try {
      await fs.mkdir(releasesDir, { recursive: true });
      console.log('✅ Directory ensured');
    } catch (dirError) {
      console.log('⚠️ Directory error (might already exist):', dirError.message);
    }

    // Check if file already exists (update vs create)
    let action = 'created';
    try {
      await fs.access(filePath);
      action = 'updated';
      console.log('📝 File exists - will update');
    } catch {
      console.log('✨ New file - will create');
    }

    // Remove filename from release data before saving
    const { filename: _, ...releaseDataWithoutFilename } = releaseData;

    // Add timestamps
    const now = new Date().toISOString();
    const finalReleaseData = {
      ...releaseDataWithoutFilename,
      updatedAt: now,
      ...(action === 'created' && { createdAt: now })
    };

    // Write the release to an individual JSON file
    try {
      await fs.writeFile(
        filePath,
        JSON.stringify(finalReleaseData, null, 2),
        'utf-8'
      );
      console.log(`✅ Successfully wrote file: ${filename}.json`);
    } catch (writeError) {
      console.error('❌ Failed to write file:', writeError);
      throw writeError;
    }

    const responseData = {
      success: true,
      releaseId: releaseData.id,
      filename: `${filename}.json`,
      action: action,
      message: `Release ${action} successfully! File saved to src/data/releases/${filename}.json`,
      path: `src/data/releases/${filename}.json`
    };

    console.log('✅ Returning success response');
    
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Error in save-release API:', error);
    console.error('Error stack:', error.stack);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error',
      details: 'Failed to save release file',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}