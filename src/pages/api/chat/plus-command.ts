// src/pages/api/chat/plus-command.ts
// Handle Plus-only chat commands: !ping, !vibe, !quote, !hype, !shoutout, !np, !uptime
// Each command limited to 1 use per day per user

import type { APIContext } from 'astro';
import { getDocument, updateDocument, initFirebaseEnv } from '../../../lib/firebase-rest';
import { getEffectiveTier, SUBSCRIPTION_TIERS, getTodayDate } from '../../../lib/subscription';

export const prerender = false;

// Admin UIDs who can use commands without limits
const ADMIN_UIDS = [
  'Y3TGc171cHSWTqZDRSniyu7Jxc33',
  '8WmxYeCp4PSym5iWHahgizokn5F2'
];

// Commands that have daily limits (1 per day)
const LIMITED_COMMANDS = ['ping', 'vibe', 'quote', 'hype', 'shoutout'];
// Commands without limits
const UNLIMITED_COMMANDS = ['np', 'uptime'];

// Philosophical responses for !ping
const PHILOSOPHICAL_RESPONSES = [
  "The beat drops not when you expect it, but when you need it most.",
  "In the silence between tracks lies the anticipation of infinite possibilities.",
  "Every bassline is a heartbeat of the universe expressing itself through sound.",
  "The DJ doesn't play music — they channel the collective energy of the room.",
  "Vinyl crackle is just the sound of time travelling through grooves.",
  "A perfect mix is like a conversation where both tracks finish each other's sentences.",
  "The dancefloor is the only democracy where everyone votes with their feet.",
  "Music doesn't fill the silence — it reveals what was always there.",
  "Every track is a time machine; every mix, a journey through dimensions.",
  "The best drops are felt in the chest before they reach the ears.",
  "A DJ's job is to turn strangers into a tribe, one track at a time.",
  "The waveform is just the soul of sound made visible.",
  "In the club, we don't escape reality — we create a better one.",
  "The needle on vinyl is writing the story of this very moment.",
  "Bass is the foundation. Melody is the dream. Rhythm is the truth.",
];

// Vibe messages for !vibe
const VIBE_MESSAGES = [
  "Current vibe: Pure euphoria on the dancefloor",
  "Vibe check: Absolutely immaculate",
  "The energy in here is unmatched right now",
  "Vibes: Off the charts. No further questions.",
  "Current mood: Lost in the music, found in the moment",
  "Vibe status: Peak performance achieved",
  "The frequency is right. The energy is aligned.",
  "Vibes: Certified fresh",
  "Mood: Main character energy, supporting cast of basslines",
  "Current state: Transcendence through sound",
  "Vibe report: All systems go. Dancefloor operational.",
  "The vibes? Impeccable. The energy? Immeasurable.",
];

// Music/DJ quotes for !quote
const MUSIC_QUOTES = [
  "\"Music is the universal language of mankind.\" — Longfellow",
  "\"Where words fail, music speaks.\" — Hans Christian Andersen",
  "\"One good thing about music, when it hits you, you feel no pain.\" — Bob Marley",
  "\"Without music, life would be a mistake.\" — Nietzsche",
  "\"Music expresses that which cannot be said.\" — Victor Hugo",
  "\"The only truth is music.\" — Jack Kerouac",
  "\"Music is the strongest form of magic.\" — Marilyn Manson",
  "\"A DJ is only as good as their record collection.\" — DJ Shadow",
  "\"The DJ saved my life.\" — Indeep",
  "\"House music is a spiritual thing, a body thing, a soul thing.\" — Frankie Knuckles",
  "\"Music can change the world because it can change people.\" — Bono",
  "\"If you have to ask what jazz is, you'll never know.\" — Louis Armstrong",
  "\"The music is not in the notes, but in the silence between.\" — Mozart",
  "\"Feel the music, not the moment.\" — Unknown DJ",
  "\"Records are not just music. They're time capsules.\" — Carl Cox",
];

// Hype messages for !hype
const HYPE_MESSAGES = [
  "LET'S GOOOOO! The energy is UNREAL right now!",
  "HANDS UP! This is what we came for!",
  "THE DROP IS COMING! GET READY!",
  "MAXIMUM HYPE ACHIEVED! No turning back now!",
  "THIS IS IT! Peak hours activated!",
  "EVERYONE MAKE SOME NOISE! The vibes are immaculate!",
  "WE'RE NOT STOPPING! Energy levels: MAXIMUM!",
  "THE BASS IS CALLING! Answer it with your soul!",
  "HYPE TRAIN HAS LEFT THE STATION! All aboard!",
  "THIS TRACK THOUGH! Absolutely sending it!",
  "LETS GET LOUD! The dancefloor demands it!",
  "FULL SEND! No regrets, only bass!",
];

function initEnv(locals: any) {
  const env = (locals as any).runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || env?.PUBLIC_FIREBASE_PROJECT_ID || 'freshwax-store',
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || env?.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  });
}

function getRandomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

export async function POST({ request, locals }: APIContext) {
  try {
    initEnv(locals);

    const body = await request.json();
    const { userId, userName, command, args, streamId, streamStartTime, currentTrack } = body;

    if (!userId || !command) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing userId or command'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check if user has Plus or is admin
    const isAdmin = ADMIN_UIDS.includes(userId);
    let isPlus = isAdmin;
    let userDoc: any = null;

    if (!isAdmin) {
      userDoc = await getDocument('users', userId);
      if (userDoc) {
        const tier = getEffectiveTier(userDoc.subscription);
        isPlus = tier === SUBSCRIPTION_TIERS.PRO;
      }
    }

    if (!isPlus) {
      return new Response(JSON.stringify({
        success: false,
        allowed: false,
        error: 'Chat commands are a Plus feature. Upgrade to Plus for !ping, !vibe, !quote, and more!'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cmdLower = command.toLowerCase();

    // Check daily limit for limited commands (admins bypass limits)
    if (!isAdmin && LIMITED_COMMANDS.includes(cmdLower)) {
      const today = getTodayDate();
      const usage = userDoc?.commandUsage || {};

      // Check if command was used today
      if (usage.date === today && usage[cmdLower]) {
        return new Response(JSON.stringify({
          success: true,
          allowed: false,
          error: `You've already used !${cmdLower} today. Each command can be used once per day.`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Record command usage
      const newUsage: Record<string, any> = { date: today };
      // Preserve other command usage from today
      if (usage.date === today) {
        Object.keys(usage).forEach(key => {
          if (key !== 'date') newUsage[key] = usage[key];
        });
      }
      newUsage[cmdLower] = true;

      await updateDocument('users', userId, {
        commandUsage: newUsage
      });
    }

    // Handle commands
    let response: string = '';
    let type: 'bot' | 'system' = 'bot';

    switch (command.toLowerCase()) {
      case 'ping':
        response = getRandomItem(PHILOSOPHICAL_RESPONSES);
        break;

      case 'vibe':
        response = getRandomItem(VIBE_MESSAGES);
        break;

      case 'quote':
        response = getRandomItem(MUSIC_QUOTES);
        break;

      case 'hype':
        response = getRandomItem(HYPE_MESSAGES);
        type = 'system'; // Hype messages show as system announcements
        break;

      case 'shoutout':
        if (!args || args.trim().length === 0) {
          response = `${userName} is sending good vibes to everyone in the chat!`;
        } else {
          const target = args.trim().replace(/^@/, '');
          response = `${userName} is giving a massive shoutout to ${target}! Show them some love!`;
        }
        type = 'system';
        break;

      case 'np':
        if (currentTrack && currentTrack.title) {
          response = `Now Playing: ${currentTrack.title}${currentTrack.artist ? ` by ${currentTrack.artist}` : ''}`;
        } else {
          response = "Currently playing: Check the player for track info!";
        }
        break;

      case 'uptime':
        if (streamStartTime) {
          const startTime = new Date(streamStartTime).getTime();
          const now = Date.now();
          const uptimeMs = now - startTime;
          const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
          const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

          if (hours > 0) {
            response = `Stream has been live for ${hours}h ${minutes}m`;
          } else {
            response = `Stream has been live for ${minutes} minutes`;
          }
        } else {
          response = "Stream uptime unavailable";
        }
        break;

      default:
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown command: ${command}`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify({
      success: true,
      allowed: true,
      response,
      type,
      command
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Plus Command API] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
