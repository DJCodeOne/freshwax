// src/pages/api/livestream/switchover.ts
// Auto-switchover management - called periodically to handle DJ transitions

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, deleteDocument, queryCollection } from '../../../lib/firebase-rest';

// POST: Check and perform auto-switchover
export const POST: APIRoute = async ({ request }) => {
  try {
    const now = new Date();
    const nowISO = now.toISOString();
    
    // 1. Check if current live slot has ended
    const activeData = await getDocument('livestreams', 'active');
    
    let transitioned = false;
    let endedSlot = null;
    let newLiveSlot = null;
    
    if (activeData?.isLive && activeData?.currentSlotId) {
      const currentSlot = await getDocument('livestreamSlots', activeData.currentSlotId);

      if (currentSlot) {
        const slotEndTime = new Date(currentSlot.endTime);

        // If slot has ended
        if (now >= slotEndTime) {
          // Mark current slot as completed
          await updateDocument('livestreamSlots', activeData.currentSlotId, {
            status: 'completed',
            endedAt: nowISO,
            updatedAt: nowISO
          });

          endedSlot = { id: activeData.currentSlotId, ...currentSlot };

          // Find next DJ in lobby
          const nextInLobby = await queryCollection('livestreamSlots', {
            filters: [{ field: 'status', op: 'EQUAL', value: 'in_lobby' }],
            orderBy: { field: 'startTime', direction: 'ASCENDING' },
            limit: 1
          });

          if (nextInLobby.length > 0) {
            const nextSlot = nextInLobby[0];

            // Automatically transition to next DJ
            await updateDocument('livestreamSlots', nextSlot.id, {
              status: 'live',
              wentLiveAt: nowISO,
              updatedAt: nowISO
            });

            // Update active stream
            await setDocument('livestreams', 'active', {
              isLive: true,
              currentSlotId: nextSlot.id,
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

            newLiveSlot = { id: nextSlot.id, ...nextSlot, status: 'live' };
            transitioned = true;
          } else {
            // No one in lobby - end stream
            await setDocument('livestreams', 'active', {
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
      const readyToStart = await queryCollection('livestreamSlots', {
        filters: [
          { field: 'status', op: 'EQUAL', value: 'in_lobby' },
          { field: 'startTime', op: 'LESS_THAN_OR_EQUAL', value: nowISO }
        ],
        orderBy: { field: 'startTime', direction: 'ASCENDING' },
        limit: 1
      });

      if (readyToStart.length > 0) {
        const slot = readyToStart[0];

        await updateDocument('livestreamSlots', slot.id, {
          status: 'live',
          wentLiveAt: nowISO,
          updatedAt: nowISO
        });

        await setDocument('livestreams', 'active', {
          isLive: true,
          currentSlotId: slot.id,
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

        newLiveSlot = { id: slot.id, ...slot, status: 'live' };
        transitioned = true;
      }
    }
    
    // 3. Mark missed slots (scheduled but DJ never joined lobby)
    const missedSlots = await queryCollection('livestreamSlots', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'scheduled' },
        { field: 'endTime', op: 'LESS_THAN', value: nowISO }
      ]
    });

    const missedUpdates = missedSlots.map(doc =>
      updateDocument('livestreamSlots', doc.id, {
        status: 'missed',
        updatedAt: nowISO
      })
    );

    await Promise.all(missedUpdates);

    // 4. Get current queue status
    const queue = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'in_lobby' }],
      orderBy: { field: 'startTime', direction: 'ASCENDING' }
    });
    
    return new Response(JSON.stringify({
      success: true,
      transitioned,
      endedSlot,
      newLiveSlot,
      missedCount: missedSlots.length,
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
    const activeData = await getDocument('livestreams', 'active');

    // Get DJs in lobby
    const queue = await queryCollection('livestreamSlots', {
      filters: [{ field: 'status', op: 'EQUAL', value: 'in_lobby' }],
      orderBy: { field: 'startTime', direction: 'ASCENDING' }
    });

    // Get upcoming scheduled
    const upcomingSlots = await queryCollection('livestreamSlots', {
      filters: [
        { field: 'status', op: 'EQUAL', value: 'scheduled' },
        { field: 'startTime', op: 'GREATER_THAN_OR_EQUAL', value: now }
      ],
      orderBy: { field: 'startTime', direction: 'ASCENDING' },
      limit: 10
    });
    
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
