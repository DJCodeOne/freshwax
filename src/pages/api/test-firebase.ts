// Quick test endpoint to verify Firebase REST API config
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const projectId = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey = import.meta.env.FIREBASE_API_KEY;

  const checks = {
    FIREBASE_PROJECT_ID: projectId ? `Set (${projectId})` : 'MISSING',
    FIREBASE_API_KEY: apiKey ? `Set (${apiKey.slice(0, 10)}...)` : 'MISSING',
  };

  // Try a simple read
  let readTest = 'Not tested';
  try {
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/settings/admin`);
    readTest = res.ok ? 'OK' : `Failed: ${res.status}`;
  } catch (e: any) {
    readTest = `Error: ${e.message}`;
  }

  // Try a write test (to a test collection)
  let writeTest = 'Not tested';
  if (apiKey) {
    try {
      const testDoc = {
        fields: {
          test: { stringValue: 'ping' },
          timestamp: { stringValue: new Date().toISOString() }
        }
      };
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/freshwax-store/databases/(default)/documents/_test/connection-check?key=${apiKey}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testDoc)
        }
      );
      writeTest = res.ok ? 'OK' : `Failed: ${res.status} - ${await res.text()}`;
    } catch (e: any) {
      writeTest = `Error: ${e.message}`;
    }
  } else {
    writeTest = 'Skipped - no API key';
  }

  return new Response(JSON.stringify({
    env: checks,
    readTest,
    writeTest,
    timestamp: new Date().toISOString()
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
