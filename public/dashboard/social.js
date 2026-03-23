// Dashboard — social module (wishlist + following)
// Handles wishlist and following tabs

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var ctx = null;
var wishlistLoaded = false;
var followingLoaded = false;

export function init(context) {
  ctx = context;
}

export function resetLoaded() {
  wishlistLoaded = false;
  followingLoaded = false;
}

// Load wishlist count for badge (lightweight)
export async function loadWishlistCount(userId) {
  var badge = document.getElementById('wishlistBadge');
  if (!badge || !ctx.getCurrentUser()) return;

  try {
    var token = await ctx.getCurrentUser().getIdToken();
    var wlCountController = new AbortController();
    var wlCountTimeout = setTimeout(function() { wlCountController.abort(); }, 15000);
    var response = await fetch('/api/wishlist/?userId=' + encodeURIComponent(userId), {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: wlCountController.signal
    });
    clearTimeout(wlCountTimeout);
    var data = await response.json();

    if (data.success) {
      var count = data.count || 0;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  } catch (err) {
    // Silent fail
  }
}

// Load wishlist
export async function loadWishlist(userId) {
  if (wishlistLoaded) return;

  var container = document.getElementById('wishlistContainer');
  var badge = document.getElementById('wishlistBadge');
  var currentUser = ctx.getCurrentUser();
  if (!container || !currentUser) return;

  container.innerHTML = '<div class="empty-state"><p style="color: #fff;">Loading wishlist...</p></div>';

  try {
    var token = await currentUser.getIdToken();
    var wlLoadController = new AbortController();
    var wlLoadTimeout = setTimeout(function() { wlLoadController.abort(); }, 15000);
    var response = await fetch('/api/wishlist/?userId=' + encodeURIComponent(userId), {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: wlLoadController.signal
    });
    clearTimeout(wlLoadTimeout);
    var data = await response.json();

    if (data.success) {
      wishlistLoaded = true;
      var wishlist = data.wishlist || [];

      // Update badge
      if (badge) {
        badge.textContent = wishlist.length;
        badge.style.display = wishlist.length > 0 ? 'inline-flex' : 'none';
      }

      if (wishlist.length === 0) {
        container.innerHTML =
          '<div class="empty-state" style="grid-column: 1/-1;">' +
            '<p style="color: #fff; margin: 0 0 1.5rem 0;">Your wishlist is empty</p>' +
            '<a href="/releases/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Browse Releases</a>' +
          '</div>';
      } else {
        container.innerHTML = wishlist.map(function(release) {
          var price = release.pricePerSale || release.pricing?.digital || 0;
          var vinylPrice = release.vinylPrice || release.vinyl?.price || release.pricing?.vinyl || 0;
          var hasVinyl = release.vinylRelease || release.vinyl?.available;
          var genre = release.genre || '';
          var labelCode = release.labelCode || '';

          return '<div class="wishlist-card" data-release-id="' + escapeHtml(release.id) + '">' +
            '<div class="wishlist-card-artwork">' +
              '<a href="/item/' + escapeHtml(release.id) + '/">' +
                '<img src="' + escapeHtml(release.coverArtUrl || '/place-holder.webp') + '" alt="' + escapeHtml(release.releaseName) + '" loading="lazy">' +
              '</a>' +
            '</div>' +
            '<div class="wishlist-card-content">' +
              '<h4 class="wishlist-card-title">' + escapeHtml(release.releaseName || 'Unknown') + '</h4>' +
              '<p class="wishlist-card-artist">by ' + escapeHtml(release.artistName || 'Unknown Artist') + '</p>' +
              '<div class="wishlist-card-meta">' +
                (genre ? '<span class="wishlist-card-tag">' + escapeHtml(genre) + '</span>' : '') +
                (labelCode ? '<span class="wishlist-card-tag">' + escapeHtml(labelCode) + '</span>' : '') +
                '<span class="wishlist-card-tag" style="background:#22c55e;color:#fff;">DIGITAL</span>' +
                (hasVinyl ? '<span class="wishlist-card-tag" style="background:#dc2626;color:#fff;">VINYL</span>' : '') +
              '</div>' +
            '</div>' +
            '<div class="wishlist-card-right">' +
              '<div class="wishlist-card-price">' +
                '<span class="price-digital"><span class="price-label">Digital</span> £' + price.toFixed(2) + '</span>' +
                (hasVinyl ? '<span class="price-vinyl"><span class="price-label">Vinyl</span> £' + vinylPrice.toFixed(2) + '</span>' : '') +
              '</div>' +
              '<div class="wishlist-card-actions">' +
                '<a href="/item/' + escapeHtml(release.id) + '/" class="wishlist-btn-view">View</a>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Attach remove handlers
        container.querySelectorAll('.wishlist-card-remove').forEach(function(btn) {
          btn.addEventListener('click', async function(e) {
            e.preventDefault();
            var releaseId = btn.dataset.releaseId;
            var card = btn.closest('.wishlist-card');

            // Optimistic removal
            card.style.opacity = '0.5';
            card.style.pointerEvents = 'none';

            try {
              var removeToken = await currentUser.getIdToken();
              var wlRemoveController = new AbortController();
              var wlRemoveTimeout = setTimeout(function() { wlRemoveController.abort(); }, 15000);
              var res = await fetch('/api/wishlist/', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + removeToken
                },
                body: JSON.stringify({
                  userId: userId,
                  releaseId: releaseId,
                  action: 'remove'
                }),
                signal: wlRemoveController.signal
              });
              clearTimeout(wlRemoveTimeout);

              var result = await res.json();
              if (result.success) {
                card.remove();

                // Update badge and check if empty
                var remaining = container.querySelectorAll('.wishlist-card').length;
                if (badge) {
                  badge.textContent = remaining;
                  badge.style.display = remaining > 0 ? 'inline' : 'none';
                }

                if (remaining === 0) {
                  container.innerHTML =
                    '<div class="empty-state" style="grid-column: 1/-1;">' +
                      '<p style="color: #fff; margin: 0 0 1.5rem 0;">Your wishlist is empty</p>' +
                      '<a href="/releases/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Browse Releases</a>' +
                    '</div>';
                }
              } else {
                card.style.opacity = '1';
                card.style.pointerEvents = 'auto';
              }
            } catch (err) {
              card.style.opacity = '1';
              card.style.pointerEvents = 'auto';
            }
          });
        });

        // Attach add to cart handlers
        container.querySelectorAll('.wishlist-btn-cart').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var releaseId = btn.dataset.releaseId;
            var price = parseFloat(btn.dataset.price) || 0;
            var title = btn.dataset.title;
            var artist = btn.dataset.artist;
            var artwork = btn.dataset.artwork;

            // Use existing cart system
            if (window.addToCart) {
              window.addToCart({
                id: releaseId,
                type: 'digital',
                price: price,
                title: title,
                artist: artist,
                artwork: artwork
              });
            } else if (window.FreshWaxCart && window.FreshWaxCart.add) {
              window.FreshWaxCart.add({
                releaseId: releaseId,
                productType: 'digital',
                price: price,
                title: title,
                artist: artist,
                artwork: artwork
              });
            } else {
              // Fallback: dispatch cart event
              window.dispatchEvent(new CustomEvent('add-to-cart', {
                detail: {
                  releaseId: releaseId,
                  productType: 'digital',
                  price: price,
                  title: title,
                  artist: artist,
                  artwork: artwork
                }
              }));
            }

            // Visual feedback
            btn.textContent = 'Added ✓';
            btn.style.background = '#16a34a';
            btn.style.borderColor = '#16a34a';
            setTimeout(function() {
              btn.textContent = 'Add to Cart';
              btn.style.background = '#dc2626';
              btn.style.borderColor = '#dc2626';
            }, 2000);
          });
        });
      }
    } else {
      container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><p style="color: #fff;">Could not load wishlist</p></div>';
    }
  } catch (error) {
    console.error('[Dashboard] Wishlist fetch error:', error);
    container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><p style="color: #fff;">Error loading wishlist</p></div>';
  }
}

// Load following count for badge
export async function loadFollowingCount(userId) {
  var badge = document.getElementById('followingBadge');
  if (!badge || !ctx.getCurrentUser()) return;

  try {
    var token = await ctx.getCurrentUser().getIdToken();
    var fCountController = new AbortController();
    var fCountTimeout = setTimeout(function() { fCountController.abort(); }, 15000);
    var response = await fetch('/api/follow-artist/?userId=' + encodeURIComponent(userId), {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: fCountController.signal
    });
    clearTimeout(fCountTimeout);
    var data = await response.json();

    if (data.success) {
      var count = data.count || 0;
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  } catch (err) {
    // Silent fail
  }
}

// Load followed artists
export async function loadFollowing(userId) {
  if (followingLoaded) return;

  var container = document.getElementById('followingContainer');
  var badge = document.getElementById('followingBadge');
  var currentUser = ctx.getCurrentUser();
  if (!container || !currentUser) return;

  container.innerHTML = '<div class="empty-state"><p style="color: #fff;">Loading artists...</p></div>';

  try {
    var token = await currentUser.getIdToken();
    var fLoadController = new AbortController();
    var fLoadTimeout = setTimeout(function() { fLoadController.abort(); }, 15000);
    var response = await fetch('/api/follow-artist/?userId=' + encodeURIComponent(userId), {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: fLoadController.signal
    });
    clearTimeout(fLoadTimeout);
    var data = await response.json();

    if (data.success) {
      followingLoaded = true;
      var artists = data.followedArtists || [];

      // Update badge
      if (badge) {
        badge.textContent = artists.length;
        badge.style.display = artists.length > 0 ? 'inline-flex' : 'none';
      }

      if (artists.length === 0) {
        container.innerHTML =
          '<div class="empty-state" style="grid-column: 1/-1;">' +
            '<p style="color: #fff; margin: 0 0 1.5rem 0;">You\'re not following any artists yet</p>' +
            '<a href="/releases/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Browse Releases</a>' +
          '</div>';
      } else {
        container.innerHTML = artists.map(function(artist) {
          var latestRelease = artist.latestRelease;
          var releaseCount = artist.releaseCount || 0;

          return '<div class="following-card" data-artist-name="' + escapeHtml(artist.artistName) + '">' +
            '<img src="' + escapeHtml(artist.coverArtUrl || '/place-holder.webp') + '" alt="' + escapeHtml(artist.artistName) + '" class="following-card-avatar">' +
            '<h4 class="following-card-name">' + escapeHtml(artist.artistName) + '</h4>' +
            '<p class="following-card-releases">' + releaseCount + ' release' + (releaseCount !== 1 ? 's' : '') + '</p>' +
            (latestRelease ?
              '<div class="following-card-latest">' +
                '<div class="following-card-latest-label">Latest Release</div>' +
                '<div class="following-card-latest-title" title="' + escapeHtml(latestRelease.releaseName) + '">' + escapeHtml(latestRelease.releaseName) + '</div>' +
              '</div>' : '') +
            '<div class="following-card-actions">' +
              (latestRelease ? '<a href="/item/' + escapeHtml(latestRelease.id) + '/" class="following-btn-view">View Latest</a>' : '<a href="/releases/" class="following-btn-view">Browse</a>') +
              '<button class="following-btn-unfollow" data-artist-name="' + escapeHtml(artist.artistName) + '">Unfollow</button>' +
            '</div>' +
          '</div>';
        }).join('');

        // Attach unfollow handlers
        container.querySelectorAll('.following-btn-unfollow').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            var artistName = btn.dataset.artistName;
            var card = btn.closest('.following-card');

            // Optimistic removal
            card.style.opacity = '0.5';
            card.style.pointerEvents = 'none';

            try {
              var unfollowToken = await currentUser.getIdToken();
              var unfollowController = new AbortController();
              var unfollowTimeout = setTimeout(function() { unfollowController.abort(); }, 15000);
              var res = await fetch('/api/follow-artist/', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + unfollowToken
                },
                body: JSON.stringify({
                  userId: userId,
                  artistName: artistName,
                  action: 'unfollow'
                }),
                signal: unfollowController.signal
              });
              clearTimeout(unfollowTimeout);

              var result = await res.json();
              if (result.success) {
                card.remove();

                // Update badge and check if empty
                var remaining = container.querySelectorAll('.following-card').length;
                if (badge) {
                  badge.textContent = remaining;
                  badge.style.display = remaining > 0 ? 'inline' : 'none';
                }

                if (remaining === 0) {
                  container.innerHTML =
                    '<div class="empty-state" style="grid-column: 1/-1;">' +
                      '<p style="color: #fff; margin: 0 0 1.5rem 0;">You\'re not following any artists yet</p>' +
                      '<a href="/releases/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Browse Releases</a>' +
                    '</div>';
                }
              } else {
                card.style.opacity = '1';
                card.style.pointerEvents = 'auto';
              }
            } catch (err) {
              card.style.opacity = '1';
              card.style.pointerEvents = 'auto';
            }
          });
        });
      }
    } else {
      container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><p style="color: #fff;">Could not load artists</p></div>';
    }
  } catch (error) {
    console.error('[Dashboard] Following fetch error:', error);
    container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><p style="color: #fff;">Error loading artists</p></div>';
  }
}
