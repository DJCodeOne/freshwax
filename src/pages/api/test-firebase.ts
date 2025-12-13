// Quick test endpoint to verify Firebase REST API config
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  // Try multiple ways to access env vars on Cloudflare
  const runtime = (locals as any).runtime;
  const cfEnv = runtime?.env || {};

  // Method 1: import.meta.env (build-time)
  const projectId1 = import.meta.env.FIREBASE_PROJECT_ID;
  const apiKey1 = import.meta.env.FIREBASE_API_KEY;

  // Method 2: Cloudflare runtime env
  const projectId2 = cfEnv.FIREBASE_PROJECT_ID;
  const apiKey2 = cfEnv.FIREBASE_API_KEY;

  // Method 3: process.env (Node.js style)
  const projectId3 = (globalThis as any).process?.env?.FIREBASE_PROJECT_ID;
  const apiKey3 = (globalThis as any).process?.env?.FIREBASE_API_KEY;

  const projectId = projectId1 || projectId2 || projectId3;
  const apiKey = apiKey1 || apiKey2 || apiKey3;

  const checks = {
    'import.meta.env.FIREBASE_PROJECT_ID': projectId1 || 'MISSING',
    'import.meta.env.FIREBASE_API_KEY': apiKey1 ? `${apiKey1.slice(0,10)}...` : 'MISSING',
    'runtime.env.FIREBASE_PROJECT_ID': projectId2 || 'MISSING',
    'runtime.env.FIREBASE_API_KEY': apiKey2 ? `${apiKey2.slice(0,10)}...` : 'MISSING',
    'process.env.FIREBASE_PROJECT_ID': projectId3 || 'MISSING',
    'process.env.FIREBASE_API_KEY': apiKey3 ? `${apiKey3.slice(0,10)}...` : 'MISSING',
    'hasRuntime': !!runtime,
    'runtimeEnvKeys': Object.keys(cfEnv),
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
