// /src/pages/api/admin/approve-partner.ts
// API endpoint to approve a partner

import type { APIRoute } from 'astro';
import { updateDocument } from '../../../lib/firebase-rest';

export const POST: APIRoute = async ({ request }) => {
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