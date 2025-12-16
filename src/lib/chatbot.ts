// src/lib/chatbot.ts
// FreshWax Chat Bot - Automated chat responses and announcements

// Bot identity
export const BOT_USER = {
  id: 'freshwax-bot',
  name: 'FreshWax Bot',
  avatar: '/logo.webp',
  badge: 'BOT'
};

// Bot commands and their handlers
export const BOT_COMMANDS: Record<string, {
  description: string;
  handler: (streamId: string, env: any) => Promise<string>;
}> = {
  '!help': {
    description: 'Show available commands',
    handler: async () => {
      return `Available commands:
!help - Show this help message
!dj - Show current DJ info
!schedule - Show today's lineup
!next - Show who's up next
!rules - Chat rules`;
    }
  },
  '!dj': {
    description: 'Show current DJ info',
    handler: async (streamId, env) => {
      const stream = await getCurrentStream(streamId, env);
      if (stream) {
        return `Now playing: ${stream.djName} - ${stream.title || 'Live Session'}${stream.genre ? ` | Genre: ${stream.genre}` : ''}`;
      }
      return 'No one is currently streaming.';
    }
  },
  '!schedule': {
    description: "Show today's lineup",
    handler: async (streamId, env) => {
      const slots = await getTodaySchedule(env);
      if (slots.length === 0) {
        return 'No scheduled streams today. Check back later!';
      }
      const schedule = slots.slice(0, 5).map(slot => {
        const time = new Date(slot.scheduledFor).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/London'
        });
        return `${time} - ${slot.djName}`;
      }).join('\n');
      return `Today's lineup:\n${schedule}${slots.length > 5 ? `\n...and ${slots.length - 5} more` : ''}`;
    }
  },
  '!next': {
    description: "Show who's up next",
    handler: async (streamId, env) => {
      const nextSlot = await getNextSlot(env);
      if (nextSlot) {
        const time = new Date(nextSlot.scheduledFor).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/London'
        });
        return `Up next at ${time}: ${nextSlot.djName}${nextSlot.title ? ` - ${nextSlot.title}` : ''}`;
      }
      return 'No upcoming DJs scheduled.';
    }
  },
  '!rules': {
    description: 'Show chat rules',
    handler: async () => {
      return `Chat Rules:
1. Be respectful to everyone
2. No spam or excessive caps
3. No self-promotion without permission
4. Keep it music-related
5. Have fun and enjoy the vibes!`;
    }
  }
};

// Helper: Get current stream info
async function getCurrentStream(streamId: string, env: any): Promise<any> {
  try {
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    const projectId = 'freshwax-store';

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/livestreamSlots/${streamId}?key=${apiKey}`
    );

    if (!response.ok) return null;

    const data = await response.json();
    return {
      djName: data.fields?.djName?.stringValue || 'Unknown DJ',
      title: data.fields?.title?.stringValue || '',
      genre: data.fields?.genre?.stringValue || ''
    };
  } catch {
    return null;
  }
}

// Helper: Get today's schedule
async function getTodaySchedule(env: any): Promise<any[]> {
  try {
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    const projectId = 'freshwax-store';

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const query = {
      structuredQuery: {
        from: [{ collectionId: 'livestreamSlots' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: 'scheduledFor' },
                  op: 'GREATER_THAN_OR_EQUAL',
                  value: { stringValue: startOfDay }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: 'scheduledFor' },
                  op: 'LESS_THAN',
                  value: { stringValue: endOfDay }
                }
              }
            ]
          }
        },
        orderBy: [{ field: { fieldPath: 'scheduledFor' }, direction: 'ASCENDING' }],
        limit: 10
      }
    };

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      }
    );

    if (!response.ok) return [];

    const results = await response.json();
    return results
      .filter((r: any) => r.document)
      .map((r: any) => ({
        djName: r.document.fields?.djName?.stringValue || 'TBA',
        title: r.document.fields?.title?.stringValue || '',
        scheduledFor: r.document.fields?.scheduledFor?.stringValue || ''
      }));
  } catch {
    return [];
  }
}

// Helper: Get next scheduled slot
async function getNextSlot(env: any): Promise<any> {
  try {
    const apiKey = env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY;
    const projectId = 'freshwax-store';

    const now = new Date().toISOString();

    const query = {
      structuredQuery: {
        from: [{ collectionId: 'livestreamSlots' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: 'scheduledFor' },
                  op: 'GREATER_THAN',
                  value: { stringValue: now }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: 'status' },
                  op: 'EQUAL',
                  value: { stringValue: 'scheduled' }
                }
              }
            ]
          }
        },
        orderBy: [{ field: { fieldPath: 'scheduledFor' }, direction: 'ASCENDING' }],
        limit: 1
      }
    };

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      }
    );

    if (!response.ok) return null;

    const results = await response.json();
    const doc = results[0]?.document;

    if (!doc) return null;

    return {
      djName: doc.fields?.djName?.stringValue || 'TBA',
      title: doc.fields?.title?.stringValue || '',
      scheduledFor: doc.fields?.scheduledFor?.stringValue || ''
    };
  } catch {
    return null;
  }
}

// Check if message is a bot command
export function isBotCommand(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  return trimmed.startsWith('!') && BOT_COMMANDS[trimmed.split(' ')[0]] !== undefined;
}

// Process a bot command and return the response
export async function processBotCommand(message: string, streamId: string, env: any): Promise<string | null> {
  const command = message.trim().toLowerCase().split(' ')[0];
  const handler = BOT_COMMANDS[command];

  if (handler) {
    return await handler.handler(streamId, env);
  }

  return null;
}

// Pre-defined bot announcements
export const BOT_ANNOUNCEMENTS = {
  welcome: (djName: string) => `Welcome to the stream! ${djName} is now live. Type !help for commands.`,
  nextDj: (djName: string, minutes: number) => `Coming up in ${minutes} minutes: ${djName}`,
  streamEnding: () => `This stream is ending soon. Thanks for watching!`,
  raidIncoming: (fromDj: string) => `Incoming raid from ${fromDj}! Welcome raiders!`,
  milestone: (viewers: number) => `We hit ${viewers} viewers! Thanks for the support!`
};
