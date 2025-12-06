// src/pages/api/livestream/switchover.ts
// Auto-switchover management - called periodically to handle DJ transitions

import type { APIRoute } from 'astro';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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

// POST: Check and perform auto-switchover
export const POST: APIRoute = async ({ request }) => {
  try {
    const now = new Date();
    const nowISO = now.toISOString();
    
    // 1. Check if current live slot has ended
    const activeDoc = await db.collection('livestreams').doc('active').get();
    const activeData = activeDoc.exists ? activeDoc.data() : null;
    
    let transitioned = false;
    let endedSlot = null;
    let newLiveSlot = null;
    
    if (activeData?.isLive && activeData?.currentSlotId) {
      const currentSlotRef = db.collection('livestreamSlots').doc(activeData.currentSlotId);
      const currentSlotDoc = await currentSlotRef.get();
      
      if (currentSlotDoc.exists) {
        const currentSlot = currentSlotDoc.data();
        const slotEndTime = new Date(currentSlot.endTime);
        
        // If slot has ended
        if (now >= slotEndTime) {
          // Mark current slot as completed
          await currentSlotRef.update({
            status: 'completed',
            endedAt: nowISO,
            updatedAt: nowISO
          });
          
          endedSlot = { id: activeData.currentSlotId, ...currentSlot };
          
          // Find next DJ in lobby
          const nextInLobby = await db.collection('livestreamSlots')
            .where('status', '==', 'in_lobby')
            .orderBy('startTime', 'asc')
            .limit(1)
            .get();
          
          if (!nextInLobby.empty) {
            const nextSlotDoc = nextInLobby.docs[0];
            const nextSlot = nextSlotDoc.data();
            
            // Automatically transition to next DJ
            await nextSlotDoc.ref.update({
              status: 'live',
              wentLiveAt: nowISO,
              updatedAt: nowISO
            });
            
            // Update active stream
            await db.collection('livestreams').doc('active').set({
              isLive: true,
              currentSlotId: nextSlotDoc.id,
              djId: nextSlot.djId,
              djName: nextSlot.djName,
              djAvatar: nextSlot.djAvatar,
              title: nextSlot.title,
              genre: nextSlot.genre,
              description: nextSlot.description,
              startedAt: nowISO,
              scheduledEndTime: nextSlot.endTime,
              streamKey: nextSlot.streamKey,
              transitionedFrom: activeData.currentSlotId
            });
            
            newLiveSlot = { id: nextSlotDoc.id, ...nextSlot, status: 'live' };
            transitioned = true;
          } else {
            // No one in lobby - end stream
            await db.collection('livestreams').doc('active').set({
              isLive: false,
              currentSlotId: null,
              endedAt: nowISO,
              lastDjId: activeData.djId,
              lastDjName: activeData.djName
            });
          }
        }
      }
    }
    
    // 2. Auto-start for DJs in lobby whose slot time has arrived
    if (!activeData?.isLive) {
      const readyToStart = await db.collection('livestreamSlots')
        .where('status', '==', 'in_lobby')
        .where('startTime', '<=', nowISO)
        .orderBy('startTime', 'asc')
        .limit(1)
        .get();
      
      if (!readyToStart.empty) {
        const slotDoc = readyToStart.docs[0];
        const slot = slotDoc.data();
        
        await slotDoc.ref.update({
          status: 'live',
          wentLiveAt: nowISO,
          updatedAt: nowISO
        });
        
        await db.collection('livestreams').doc('active').set({
          isLive: true,
          currentSlotId: slotDoc.id,
          djId: slot.djId,
          djName: slot.djName,
          djAvatar: slot.djAvatar,
          title: slot.title,
          genre: slot.genre,
          description: slot.description,
          startedAt: nowISO,
          scheduledEndTime: slot.endTime,
          streamKey: slot.streamKey
        });
        
        newLiveSlot = { id: slotDoc.id, ...slot, status: 'live' };
        transitioned = true;
      }
    }
    
    // 3. Mark missed slots (scheduled but DJ never joined lobby)
    const missedSlots = await db.collection('livestreamSlots')
      .where('status', '==', 'scheduled')
      .where('endTime', '<', nowISO)
      .get();
    
    const missedUpdates = missedSlots.docs.map(doc => 
      doc.ref.update({
        status: 'missed',
        updatedAt: nowISO
      })
    );
    
    await Promise.all(missedUpdates);
    
    // 4. Get current queue status
    const inLobby = await db.collection('livestreamSlots')
      .where('status', '==', 'in_lobby')
      .orderBy('startTime', 'asc')
      .get();
    
    const queue = inLobby.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return new Response(JSON.stringify({
      success: true,
      transitioned,
      endedSlot,
      newLiveSlot,
      missedCount: missedSlots.size,
      queue,
      timestamp: nowISO
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[livestream/switchover] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Switchover check failed'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// GET: Get current queue and live status
export const GET: APIRoute = async () => {
  try {
    const now = new Date().toISOString();
    
    // Get active stream
    const activeDoc = await db.collection('livestreams').doc('active').get();
    const activeData = activeDoc.exists ? activeDoc.data() : null;
    
    // Get DJs in lobby
    const inLobby = await db.collection('livestreamSlots')
      .where('status', '==', 'in_lobby')
      .orderBy('startTime', 'asc')
      .get();
    
    const queue = inLobby.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Get upcoming scheduled
    const upcoming = await db.collection('livestreamSlots')
      .where('status', '==', 'scheduled')
      .where('startTime', '>=', now)
      .orderBy('startTime', 'asc')
      .limit(10)
      .get();
    
    const upcomingSlots = upcoming.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return new Response(JSON.stringify({
      success: true,
      isLive: activeData?.isLive || false,
      currentStream: activeData?.isLive ? activeData : null,
      queue,
      upcoming: upcomingSlots
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
    
  } catch (error) {
    console.error('[livestream/switchover] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to get queue status'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
