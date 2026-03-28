/**
 * Release plate — rating system and user ratings.
 * Extracted from api.ts for focused module organization.
 */
import { createClientLogger } from '../client-logger';
import { TIMEOUTS } from '../timeouts';
import { FWCache, getAuthUser } from './cache';

const log = createClientLogger('ReleasePlate');

// ============================================
// RATING SYSTEM
// ============================================
const ratingDebounce: Record<string, boolean> = {};
let pendingRatingsRequest: Promise<Record<string, RatingData>> | null = null;

export function initRatingSystem() {
  const releaseCards = document.querySelectorAll('[data-release]');
  const needsFetch: string[] = [];

  releaseCards.forEach(function(card) {
    if (card.hasAttribute('data-ratings-init')) return;
    card.setAttribute('data-ratings-init', 'true');

    const id = card.getAttribute('data-release');
    if (!id) return;

    const hasServerRatings = card.getAttribute('data-has-server-ratings') === 'true';
    if (hasServerRatings) return;

    const cached = FWCache.get('ratings');
    if (cached && cached[id]) {
      updateSingleRatingUI(card, id, cached[id]);
    } else {
      needsFetch.push(id);
    }
  });

  if (needsFetch.length === 0) {
    setupRatingClickHandlers();
    return;
  }

  if (pendingRatingsRequest) {
    pendingRatingsRequest.then(function(ratings) {
      releaseCards.forEach(function(card) {
        const id = card.getAttribute('data-release');
        if (ratings && id && ratings[id]) {
          updateSingleRatingUI(card, id, ratings[id]);
        }
      });
    });
    setupRatingClickHandlers();
    return;
  }

  pendingRatingsRequest = fetch('/api/get-ratings-batch/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ releaseIds: needsFetch })
  })
  .then(function(response) { return response.ok ? response.json() : null; })
  .then(function(data) {
    pendingRatingsRequest = null;
    if (data && data.success && data.ratings) {
      FWCache.update('ratings', function(current: Record<string, RatingData>) {
        return Object.assign({}, current, data.ratings);
      });
      return data.ratings;
    }
    return {};
  })
  .catch(function(error: unknown) {
    pendingRatingsRequest = null;
    return {};
  });

  pendingRatingsRequest.then(function(ratings) {
    releaseCards.forEach(function(card) {
      const id = card.getAttribute('data-release');
      if (ratings && id && ratings[id]) {
        updateSingleRatingUI(card, id, ratings[id]);
      }
    });
  });

  setupRatingClickHandlers();
}

function updateSingleRatingUI(card: Element, releaseId: string, ratingData: RatingData) {
  const average = ratingData.average || 0;
  const count = ratingData.count || 0;

  const ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
  const ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');

  if (ratingValue) ratingValue.textContent = average.toFixed(1);
  if (ratingCount) ratingCount.textContent = ' (' + count + ')';
}

function setupRatingClickHandlers() {
  document.querySelectorAll('.rating-star').forEach(function(star) {
    if (star.hasAttribute('data-rating-click-init')) return;
    star.setAttribute('data-rating-click-init', 'true');

    (star as HTMLElement).onclick = async function() {
      const releaseId = star.getAttribute('data-release-id');
      const rating = parseInt(star.getAttribute('data-star') || '0');

      if (!releaseId) return;

      if (ratingDebounce[releaseId]) return;
      ratingDebounce[releaseId] = true;
      setTimeout(function() { delete ratingDebounce[releaseId]; }, TIMEOUTS.RATING_DEBOUNCE);

      const user = await getAuthUser();
      if (!user) {
        alert('Please log in to rate releases.');
        const currentPage = window.location.pathname;
        window.location.href = '/login/?redirect=' + encodeURIComponent(currentPage);
        return;
      }

      let idToken: string | null = null;
      try {
        if (window.firebaseAuth && window.firebaseAuth.currentUser) {
          idToken = await window.firebaseAuth.currentUser.getIdToken();
        }
      } catch (e: unknown) { /* intentional: token refresh failed — proceed with unauthenticated rating */ }

      const card = document.querySelector('[data-release="' + releaseId + '"]');

      // Optimistic UI update
      if (card) {
        card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(s) {
          const starNum = parseInt(s.getAttribute('data-star') || '0');
          const svg = s.querySelector('svg');
          if (svg) {
            svg.setAttribute('fill', starNum <= rating ? 'currentColor' : 'none');
          }
        });
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (idToken) {
        headers['Authorization'] = 'Bearer ' + idToken;
      }

      fetch('/api/rate-release/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ releaseId: releaseId, rating: rating, userId: user.uid })
      })
      .then(function(response) { return response.ok ? response.json() : null; })
      .then(function(data) {
        if (data && data.success) {
          FWCache.update('ratings', function(current: Record<string, RatingData>) {
            current[releaseId] = { average: data.newRating, count: data.ratingsCount };
            return current;
          });

          if (card) {
            const ratingValue = card.querySelector('.rating-value[data-release-id="' + releaseId + '"]');
            const ratingCount = card.querySelector('.rating-count[data-release-id="' + releaseId + '"]');
            if (ratingValue) ratingValue.textContent = data.newRating.toFixed(1);
            if (ratingCount) ratingCount.textContent = ' (' + data.ratingsCount + ')';
          }
        }
      })
      .catch(function(error: unknown) { log.error('Rating submission error:', error); });
    };
  });
}

// ============================================
// USER RATINGS
// ============================================
let userRatingsFetched = false;

export async function fetchUserRatings() {
  if (userRatingsFetched) return;

  const user = await getAuthUser();
  if (!user) return;

  userRatingsFetched = true;

  const releaseCards = document.querySelectorAll('[data-release]');
  const releaseIds: string[] = [];
  releaseCards.forEach(function(card) {
    const id = card.getAttribute('data-release');
    if (id) releaseIds.push(id);
  });

  if (releaseIds.length === 0) return;

  let idToken: string | null = null;
  try {
    if (window.firebaseAuth && window.firebaseAuth.currentUser) {
      idToken = await window.firebaseAuth.currentUser.getIdToken();
    }
  } catch (e: unknown) { /* intentional: token refresh failed — will bail out below since idToken is null */ }

  if (!idToken) return;

  try {
    const response = await fetch('/api/get-user-ratings/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify({ releaseIds: releaseIds })
    });

    if (!response.ok) return;
    const data = await response.json();

    if (data.success && data.userRatings) {
      Object.keys(data.userRatings).forEach(function(releaseId: string) {
        const userRating = data.userRatings[releaseId];
        const card = document.querySelector('[data-release="' + releaseId + '"]');
        if (card) {
          card.querySelectorAll('.rating-star[data-release-id="' + releaseId + '"]').forEach(function(star) {
            const starNum = parseInt(star.getAttribute('data-star') || '0');
            const svg = star.querySelector('svg');
            if (svg) {
              svg.setAttribute('fill', starNum <= userRating ? 'currentColor' : 'none');
            }
          });
        }
      });
    }
  } catch (e: unknown) {
    log.error('Failed to fetch user ratings:', e);
  }
}
