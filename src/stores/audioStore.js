// src/stores/audioStore.js
// Global audio state management using nanostores
import { atom, map } from 'nanostores';

// Current mix data
export const currentMix = map({
  id: null,
  title: '',
  dj_name: '',
  artwork_url: '/place-holder.webp',
  audio_url: '',
  genre: '',
  plays: 0,
  likes: 0,
  downloads: 0
});

// Playback state
export const isPlaying = atom(false);
export const currentTime = atom(0);
export const duration = atom(0);
export const volume = atom(70);
export const isMiniPlayerVisible = atom(false);

// Track if play has been counted for current mix
export const hasTrackedPlay = atom(false);

// Mix data cache to reduce API calls
const mixCache = new Map();

// Cache a mix
export function cacheMix(id, mixData) {
  mixCache.set(id, {
    data: mixData,
    timestamp: Date.now()
  });
}

// Get cached mix (valid for 5 minutes)
export function getCachedMix(id) {
  const cached = mixCache.get(id);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return cached.data;
  }
  return null;
}

// Set current mix and show mini player
export function setCurrentMix(mixData) {
  // Only reset play tracking if it's a different mix
  if (currentMix.get().id !== mixData.id) {
    hasTrackedPlay.set(false);
  }
  
  currentMix.set({
    id: mixData.id,
    title: mixData.title || 'Untitled Mix',
    dj_name: mixData.dj_name || 'Unknown DJ',
    artwork_url: mixData.artwork_url || '/place-holder.webp',
    audio_url: mixData.audio_url || '',
    genre: mixData.genre || 'Jungle & Drum and Bass',
    plays: mixData.plays || 0,
    likes: mixData.likes || 0,
    downloads: mixData.downloads || 0
  });
  
  isMiniPlayerVisible.set(true);
  
  // Cache this mix
  cacheMix(mixData.id, mixData);
}

// Clear current mix and hide mini player
export function clearCurrentMix() {
  currentMix.set({
    id: null,
    title: '',
    dj_name: '',
    artwork_url: '/place-holder.webp',
    audio_url: '',
    genre: '',
    plays: 0,
    likes: 0,
    downloads: 0
  });
  isPlaying.set(false);
  currentTime.set(0);
  duration.set(0);
  isMiniPlayerVisible.set(false);
  hasTrackedPlay.set(false);
}

// Format time helper
export function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format duration for display (full text)
export function formatDurationFull(seconds) {
  if (!seconds || !isFinite(seconds)) return '--:--';
  
  const totalMins = Math.floor(seconds / 60);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  
  if (hours > 0) {
    const hourWord = hours === 1 ? 'hour' : 'hours';
    const minWord = mins === 1 ? 'minute' : 'minutes';
    return `${hours} ${hourWord} ${mins} ${minWord}`;
  } else {
    const minWord = mins === 1 ? 'minute' : 'minutes';
    return `${mins} ${minWord}`;
  }
}

// Format remaining time
export function formatRemaining(remaining, isMobile = false) {
  if (!remaining || !isFinite(remaining)) return 'Ready to play';
  
  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = Math.floor(remaining % 60);
  
  if (isMobile) {
    if (hours > 0) {
      return `-${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `-${mins}:${secs.toString().padStart(2, '0')}`;
  }
  
  const hourWord = hours === 1 ? 'hour' : 'hours';
  const minWord = mins === 1 ? 'minute' : 'minutes';
  const secWord = secs === 1 ? 'second' : 'seconds';
  
  if (hours > 0) {
    return `${hours} ${hourWord} ${mins} ${minWord} ${secs} ${secWord} remaining`;
  } else if (mins > 0) {
    return `${mins} ${minWord} ${secs} ${secWord} remaining`;
  }
  return `${secs} ${secWord} remaining`;
}