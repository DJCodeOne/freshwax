// src/pages/api/email-stats.ts
// Check daily email stats and retry skipped emails
import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const isDev = import.meta.env.DEV;
const log = {
  info: (...args: any[]) => isDev && console.log(...args),
  error: (...args: any[]) => console.error(...args),
};

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: import.meta.env.FIREBASE_PROJECT_ID,
      clientEmail: import.meta.env.FIREBASE_CLIENT_EMAIL,
      privateKey: import.meta.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

const DAILY_LIMIT = 100;

// GET: Check today's email stats
export const GET: APIRoute = async ({ url }) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get today's count
    const statsDoc = await db.collection('email-stats').doc(today).get();
    const todayCount = statsDoc.exists ? (statsDoc.data()?.count || 0) : 0;
    
    // Get skipped emails count
    const skippedSnap = await db.collection('skipped-emails')
      .where('skippedAt', '>=', today + 'T00:00:00.000Z')
      .get();
    
    // Get last 7 days stats
    const weekStats = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const doc = await db.collection('email-stats').doc(dateStr).get();
      weekStats.push({
        date: dateStr,
        count: doc.exists ? (doc.data()?.count || 0) : 0,
      });
    }
    
    return new Response(JSON.stringify({
      success: true,
      today: {
        date: today,
        sent: todayCount,
        remaining: DAILY_LIMIT - todayCount,
        limit: DAILY_LIMIT,
        skipped: skippedSnap.size,
      },
      weekStats,
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=60',
      }
    });
    
  } catch (error) {
    log.error('[email-stats] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to get stats' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// POST: Retry skipped emails (admin)
export const POST: APIRoute = async ({ request }) => {
  try {
    const { action } = await request.json();
    
    if (action === 'retry-skipped') {
      // Get today's count first
      const today = new Date().toISOString().split('T')[0];
      const statsDoc = await db.collection('email-stats').doc(today).get();
      const todayCount = statsDoc.exists ? (statsDoc.data()?.count || 0) : 0;
      
      if (todayCount >= DAILY_LIMIT) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Daily limit reached, try tomorrow',
          count: todayCount,
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get skipped emails
      const skippedSnap = await db.collection('skipped-emails')
        .orderBy('skippedAt', 'asc')
        .limit(DAILY_LIMIT - todayCount)
        .get();
      
      if (skippedSnap.empty) {
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'No skipped emails to retry',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      let retried = 0;
      let failed = 0;
      
      for (const doc of skippedSnap.docs) {
        const skippedEmail = doc.data();
        
        try {
          // Retry sending via the main endpoint
          const response = await fetch(new URL('/api/send-order-emails', request.url).toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(skippedEmail.data),
          });
          
          const result = await response.json();
          
          if (result.success && !result.skipped) {
            // Successfully sent - delete from skipped
            await doc.ref.delete();
            retried++;
          } else {
            failed++;
          }
        } catch (e) {
          failed++;
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        retried,
        failed,
        remaining: skippedSnap.size - retried - failed,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (action === 'clear-skipped') {
      // Clear all skipped emails older than 7 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      
      const oldSnap = await db.collection('skipped-emails')
        .where('skippedAt', '<', cutoff.toISOString())
        .get();
      
      const batch = db.batch();
      oldSnap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      
      return new Response(JSON.stringify({
        success: true,
        deleted: oldSnap.size,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ success: false, error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    log.error('[email-stats] Error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Failed to process' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};