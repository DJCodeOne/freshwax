// src/lib/livestream-slots/schemas.ts
// Zod schemas for slot validation
import { z } from 'zod';

export const SlotsPostSchema = z.object({
  action: z.string().min(1).max(50),
  idToken: z.string().max(5000).nullish(),
  djId: z.string().max(200).nullish(),
  djName: z.string().max(200).nullish(),
  djAvatar: z.string().max(2000).nullish(),
  startTime: z.string().max(100).nullish(),
  duration: z.number().int().min(1).max(1440).nullish(),
  title: z.string().max(500).nullish(),
  genre: z.string().max(200).nullish(),
  description: z.string().max(5000).nullish(),
  slotId: z.string().max(200).nullish(),
  streamKey: z.string().max(500).nullish(),
  twitchUsername: z.string().max(200).nullish(),
  twitchStreamKey: z.string().max(500).nullish(),
  broadcastMode: z.string().max(50).nullish(),
  relayUrl: z.string().max(2000).nullish(),
  stationName: z.string().max(200).nullish(),
}).passthrough();

export const SlotsDeleteSchema = z.object({
  slotId: z.string().min(1).max(200),
}).passthrough();
