// Dashboard — mixes tab module
// Handles DJ mix loading, rendering, and stats

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var ctx = null;
var mixesLoaded = false;

export function init(context) {
  ctx = context;

  // Reset mixesLoaded when page becomes visible again (user returns from editing)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      mixesLoaded = false; // Force refetch on next tab click
    }
  });
}

export function resetLoaded() {
  mixesLoaded = false;
}

export async function fetchMixes(userId, forceRefresh) {
  if (mixesLoaded && !forceRefresh) return;

  var container = document.getElementById('mixesContainer');
  if (!container) return;

  try {
    var response = await fetch('/api/get-dj-mixes/?userId=' + encodeURIComponent(userId));
    var data = await response.json();

    if (data.success && data.mixes) {
      var mixes = data.mixes;
      mixesLoaded = true;

      // Update stats
      var totalPlays = mixes.reduce(function(sum, m) { return sum + (m.plays || 0); }, 0);
      var totalLikes = mixes.reduce(function(sum, m) { return sum + (m.likes || 0); }, 0);

      var statMixes = document.getElementById('statMixes');
      var statMixPlays = document.getElementById('statMixPlays');
      var statMixLikes = document.getElementById('statMixLikes');

      if (statMixes) statMixes.textContent = mixes.length;
      if (statMixPlays) statMixPlays.textContent = totalPlays.toLocaleString();
      if (statMixLikes) statMixLikes.textContent = totalLikes.toLocaleString();

      if (mixes.length === 0) {
        container.innerHTML =
          '<div class="empty-state-mixes">' +
            '<div class="empty-icon">🎧</div>' +
            '<h3>No mixes yet</h3>' +
            '<p>Upload your first DJ mix to share with the community.</p>' +
            '<a href="/upload-mix/" class="btn-primary-sm">Upload Mix</a>' +
          '</div>';
      } else {
        container.innerHTML = mixes.slice(0, 6).map(function(mix) {
          // Calculate rating score (weighted average of plays, likes, downloads)
          var plays = mix.plays || mix.playCount || 0;
          var likes = mix.likes || mix.likeCount || 0;
          var downloads = mix.downloads || mix.downloadCount || 0;
          // Handle comments - could be array or number
          var commentsArray = Array.isArray(mix.comments) ? mix.comments : [];
          var commentsCount = mix.commentCount || commentsArray.length || 0;
          var rating = Math.min(100, Math.round((plays * 0.3 + likes * 2 + downloads * 1.5 + commentsCount * 3) / 10)) || 0;
          var chartPosition = mix.chartPosition || '-';

          // Handle various field name formats from API
          var djName = mix.dj_name || mix.djName || mix.artist || 'Unknown DJ';
          var rawArtworkUrl = mix.thumbUrl || mix.artwork_url || mix.artworkUrl || mix.artwork || mix.imageUrl || mix.coverUrl || '';
          // Add cache-busting parameter using updatedAt timestamp to show fresh artwork after edits
          var cacheBuster = mix.updatedAt ? new Date(mix.updatedAt).getTime() : Date.now();
          var artworkUrl = rawArtworkUrl ? (rawArtworkUrl + (rawArtworkUrl.includes('?') ? '&' : '?') + 'v=' + cacheBuster) : '';
          var mixTitle = mix.title || mix.name || 'Untitled Mix';
          var genre = mix.genre || 'Jungle & D&B';

          // Fix duration - handle NaN, null, undefined, 0, strings, formatted strings
          var rawDuration = mix.durationSeconds || mix.duration_seconds || mix.duration || 0;
          // Handle formatted strings like "1:30:00" or "45:30"
          if (typeof rawDuration === 'string' && rawDuration.includes(':')) {
            var parts = rawDuration.split(':').map(Number);
            if (parts.length === 3) {
              rawDuration = parts[0] * 3600 + parts[1] * 60 + parts[2];
            } else if (parts.length === 2) {
              rawDuration = parts[0] * 60 + parts[1];
            }
          }
          var durationNum = typeof rawDuration === 'number' ? rawDuration : parseInt(rawDuration, 10);
          var durationDisplay = '';
          if (durationNum && !isNaN(durationNum) && durationNum > 0) {
            var hrs = Math.floor(durationNum / 3600);
            var mins = Math.floor((durationNum % 3600) / 60);
            var secs = Math.floor(durationNum % 60);
            if (hrs > 0) {
              durationDisplay = hrs + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
            } else {
              durationDisplay = mins + ':' + secs.toString().padStart(2, '0');
            }
          }

          // Get latest comment preview - only show if it has real text (min 3 chars, not just emoji)
          var latestComment = commentsArray.length > 0 ? commentsArray[commentsArray.length - 1] : null;
          var commentText = latestComment ? (latestComment.text || latestComment.comment || '') : '';
          // Strip emoji-only comments and very short ones
          var textOnly = commentText.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
          var commentPreview = textOnly.length >= 3 ? commentText.substring(0, 80) : '';
          var commentAuthor = (commentPreview && latestComment) ? (latestComment.username || latestComment.author || 'Anonymous') : '';

          return '<div style="display: flex; flex-direction: row; align-items: stretch; background: linear-gradient(to bottom, #1f2937, #111827); border: 2px solid #374151; border-radius: 12px; overflow: hidden; margin-bottom: 1.25rem;">' +
            '<div style="width: 240px; min-width: 240px; height: 240px; background: #000; overflow: hidden; flex-shrink: 0;">' +
              (artworkUrl ?
                '<img src="' + escapeHtml(artworkUrl) + '" alt="' + escapeHtml(mixTitle) + '" style="width: 100%; height: 100%; object-fit: cover; display: block;" data-fallback="hide">' :
                '<div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 50%, #1a1a1a 100%); color: #fff; font-size: 4rem;">🎧</div>') +
            '</div>' +
            '<div style="flex: 1; padding: 1.75rem 2rem; display: flex; flex-direction: column; justify-content: center; gap: 1.25rem; min-width: 0;">' +
              '<div>' +
                '<div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; flex-wrap: wrap;">' +
                  '<h4 style="font-family: \'Inter\', sans-serif; font-weight: 700; font-size: 2.5rem; color: #dc2626; margin: 0; line-height: 1.1; letter-spacing: 0.02em;">' + escapeHtml(mixTitle) + '</h4>' +
                  (chartPosition !== '-' ? '<span style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.9rem; font-weight: 600;">#' + escapeHtml(String(chartPosition)) + '</span>' : '') +
                '</div>' +
                '<p style="font-size: 1.25rem; color: #d1d5db; margin: 0; font-weight: 500;">by ' + escapeHtml(djName) + '</p>' +
                '<p style="font-size: 1.125rem; color: #d1d5db; margin: 0.5rem 0 0 0;">' + escapeHtml(genre) + (durationDisplay ? ' &bull; ' + durationDisplay : '') + '</p>' +
              '</div>' +
              '<div style="display: flex; gap: 1rem; flex-wrap: wrap; background: linear-gradient(to bottom, #374151, #1f2937); padding: 0.625rem 1rem; border-radius: 8px; align-items: center; border: 1px solid #4b5563;">' +
                '<div style="text-align: center; min-width: 40px;">' +
                  '<div style="font-size: 1.125rem; font-weight: 700; color: #fff;">' + plays.toLocaleString() + '</div>' +
                  '<div style="font-size: 0.625rem; color: #d1d5db; text-transform: uppercase;">Plays</div>' +
                '</div>' +
                '<div style="text-align: center; min-width: 40px;">' +
                  '<div style="font-size: 1.125rem; font-weight: 700; color: #dc2626;">' + likes.toLocaleString() + '</div>' +
                  '<div style="font-size: 0.625rem; color: #d1d5db; text-transform: uppercase;">Likes</div>' +
                '</div>' +
                '<div style="text-align: center; min-width: 40px;">' +
                  '<div style="font-size: 1.125rem; font-weight: 700; color: #fff;">' + downloads.toLocaleString() + '</div>' +
                  '<div style="font-size: 0.625rem; color: #d1d5db; text-transform: uppercase;">DLs</div>' +
                '</div>' +
                '<div style="text-align: center; min-width: 40px;">' +
                  '<div style="font-size: 1.125rem; font-weight: 700; color: #fff;">' + commentsCount.toLocaleString() + '</div>' +
                  '<div style="font-size: 0.625rem; color: #d1d5db; text-transform: uppercase;">Cmts</div>' +
                '</div>' +
                '<div style="text-align: center; min-width: 40px;">' +
                  '<div style="font-size: 1.125rem; font-weight: 700; color: #f59e0b;">★' + rating + '</div>' +
                  '<div style="font-size: 0.625rem; color: #d1d5db; text-transform: uppercase;">Score</div>' +
                '</div>' +
                '<div style="display: flex; gap: 0.5rem; margin-left: auto; flex-shrink: 0;">' +
                  '<a href="/dj-mix/' + escapeHtml(mix.id) + '/" style="display: inline-block; padding: 0.4rem 0.875rem; background: #000; color: #fff; font-size: 0.8rem; font-weight: 600; border-radius: 5px; text-decoration: none; white-space: nowrap;">View Mix →</a>' +
                  '<a href="/account/mixes/" style="display: inline-block; padding: 0.4rem 0.875rem; background: linear-gradient(to bottom, #1f2937, #111827); color: #fff; font-size: 0.8rem; font-weight: 600; border-radius: 5px; text-decoration: none; border: 2px solid #4b5563; white-space: nowrap;">Manage</a>' +
                '</div>' +
              '</div>' +
              (commentPreview ?
                '<div style="background: linear-gradient(to bottom, #374151, #1f2937); padding: 1rem 1.5rem; border-radius: 8px; border-left: 3px solid #dc2626;">' +
                  '<p style="font-size: 1.125rem; color: #e5e7eb; margin: 0; font-style: italic;">"' + escapeHtml(commentPreview) + (commentPreview.length >= 80 ? '...' : '') + '"</p>' +
                  '<p style="font-size: 0.9rem; color: #d1d5db; margin: 0.5rem 0 0 0;">— ' + escapeHtml(commentAuthor) + '</p>' +
                '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      }
    } else {
      container.innerHTML = '<div class="empty-state"><p style="color: #fff;">Could not load mixes</p></div>';
    }
  } catch (error) {
    console.error('[Dashboard] Mixes fetch error:', error);
    container.innerHTML = '<div class="empty-state"><p style="color: #fff;">Error loading mixes</p></div>';
  }
}
