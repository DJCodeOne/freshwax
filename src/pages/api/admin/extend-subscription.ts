// src/pages/api/admin/extend-subscription.ts
// Admin endpoint to extend a user's Plus subscription

import type { APIRoute } from 'astro';
import { getDocument, updateDocument } from '../../../lib/firebase-rest';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { userId, days, reason } = body;

    if (!userId || !days) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User ID and days required'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get current user data
    const user = await getDocument('users', userId);

    if (!user) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User not found'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Calculate new expiry date
    let baseDate: Date;

    if (user.subscription?.expiresAt) {
      const currentExpiry = new Date(user.subscription.expiresAt);
      // If not expired, extend from current expiry; if expired, extend from now
      baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    } else {
      baseDate = new Date();
    }

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + parseInt(days));

    // Update user subscription
    const updateData: Record<string, any> = {
      'subscription.tier': 'pro',
      'subscription.expiresAt': newExpiry.toISOString(),
    };

    // If no subscription start date, set it now
    if (!user.subscription?.subscribedAt) {
      updateData['subscription.subscribedAt'] = new Date().toISOString();
    }

    // Add extension log
    const extensionLog = {
      extendedAt: new Date().toISOString(),
      daysAdded: parseInt(days),
      reason: reason || 'Admin extension',
      previousExpiry: user.subscription?.expiresAt || null,
      newExpiry: newExpiry.toISOString()
    };

    // Get existing extension history or create new array
    const extensionHistory = user.subscription?.extensionHistory || [];
    extensionHistory.push(extensionLog);
    updateData['subscription.extensionHistory'] = extensionHistory;

    await updateDocument('users', userId, updateData);

    console.log(`[extend-subscription] Extended ${userId} by ${days} days until ${newExpiry.toISOString()}`);

    return new Response(JSON.stringify({
      success: true,
      newExpiry: newExpiry.toISOString(),
      message: `Subscription extended by ${days} days`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[extend-subscription] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to extend subscription'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
