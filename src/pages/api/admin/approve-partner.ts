// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';

export const POST: APIRoute = async ({ request, locals }) => {
  // Initialize Firebase for Cloudflare runtime
  const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  try {
    const { partnerId } = await request.json();

    if (!partnerId) {
      return new Response(JSON.stringify({ error: 'Partner ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update partner document
    await updateDocument('artists', partnerId, {
      approved: true,
      approvedAt: new Date().toISOString(),
      status: 'approved'
    });

    // TODO: Send approval email notification
    // You could integrate with an email service like Resend, SendGrid, etc.
    // const partner = await getDocument('artists', partnerId);
    // await sendApprovalEmail(partner.email, partner.artistName);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error approving partner:', error);
    return new Response(JSON.stringify({ error: 'Failed to approve partner' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};