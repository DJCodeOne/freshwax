// Dashboard — profile module
// Handles profile form, avatar upload/remove, postcode lookup,
// download data modal, delete account modal

var ctx = null;

export function init(context) {
  ctx = context;
}

// Profile save
export function initProfileForm() {
  // Postcode lookup
  var lookupBtn = document.getElementById('lookupBtn');
  var postcodeSearch = document.getElementById('postcodeSearch');
  var lookupError = document.getElementById('lookupError');
  var lookupSuccess = document.getElementById('lookupSuccess');

  if (lookupBtn && postcodeSearch) {
    lookupBtn.addEventListener('click', async function() {
      var postcode = postcodeSearch.value.trim();
      if (!postcode) {
        lookupError.textContent = 'Please enter a postcode';
        lookupSuccess.textContent = '';
        return;
      }

      lookupBtn.textContent = 'Verifying...';
      lookupBtn.disabled = true;
      lookupError.textContent = '';
      lookupSuccess.textContent = '';

      try {
        var response = await fetch('/api/postcode-lookup/?postcode=' + encodeURIComponent(postcode));
        var data = await response.json();

        if (data.success) {
          document.getElementById('postcode').value = data.postcode;
          document.getElementById('city').value = data.city || '';
          document.getElementById('county').value = data.county || '';
          lookupSuccess.textContent = '✓ Postcode verified! Please enter your street address.';
          document.getElementById('address1')?.focus();
        } else {
          lookupError.textContent = data.error || 'Could not verify postcode';
        }
      } catch (error) {
        lookupError.textContent = 'Failed to lookup postcode';
      }

      lookupBtn.textContent = 'Verify';
      lookupBtn.disabled = false;
    });

    // Allow Enter key in postcode search
    postcodeSearch.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupBtn.click();
      }
    });
  }

  // Profile form submit
  document.getElementById('profileForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    var currentUser = ctx.getCurrentUser();
    if (!currentUser) return;

    var btn = e.target.querySelector('.save-btn');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    var newDisplayName = document.getElementById('displayName').value;
    var firstName = document.getElementById('firstName').value;
    var lastName = document.getElementById('lastName').value;

    try {
      var phoneValue = document.getElementById('phone').value;

      // Save profile via API (replaces Firestore SDK setDoc call)
      var idToken = await currentUser.getIdToken();
      var profileResponse = await fetch('/api/user-profile/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + idToken
        },
        body: JSON.stringify({
          firstName: firstName,
          lastName: lastName,
          fullName: firstName + ' ' + lastName,
          displayName: newDisplayName,
          displayNameLower: newDisplayName.toLowerCase(),
          phone: phoneValue,
          address1: document.getElementById('address1').value,
          address2: document.getElementById('address2').value,
          city: document.getElementById('city').value,
          county: document.getElementById('county').value,
          postcode: document.getElementById('postcode').value,
          country: document.getElementById('country').value
        })
      });

      var profileResult = await profileResponse.json();
      if (!profileResult.success) {
        throw new Error(profileResult.error || 'Failed to save profile');
      }

      // Update Firebase Auth profile
      await ctx.updateProfile(currentUser, { displayName: newDisplayName });

      btn.textContent = 'Saved!';
      setTimeout(function() {
        btn.textContent = 'Save Changes';
        btn.disabled = false;
      }, 2000);
    } catch (error) {
      console.error('Save error:', error);
      btn.textContent = 'Error - Try Again';
      btn.disabled = false;
    }
  });

  // Avatar upload handler
  var avatarUploadInput = document.getElementById('avatarUpload');
  var avatarStatus = document.getElementById('avatarUploadStatus');

  if (avatarUploadInput) {
    avatarUploadInput.addEventListener('change', async function(e) {
      var file = e.target.files[0];
      var currentUser = ctx.getCurrentUser();
      if (!file || !currentUser) return;

      // Validate file
      var maxSize = 2 * 1024 * 1024; // 2MB
      if (file.size > maxSize) {
        avatarStatus.textContent = 'File too large. Max 2MB.';
        avatarStatus.className = 'avatar-status error';
        return;
      }

      var validTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!validTypes.includes(file.type)) {
        avatarStatus.textContent = 'Invalid format. Use JPG, PNG, or WebP.';
        avatarStatus.className = 'avatar-status error';
        return;
      }

      avatarStatus.textContent = 'Uploading...';
      avatarStatus.className = 'avatar-status uploading';

      try {
        // Upload to API with authentication
        var formData = new FormData();
        formData.append('avatar', file);
        formData.append('userId', currentUser.uid);

        // Get idToken for Firestore write authentication
        var idToken = await currentUser.getIdToken();

        var response = await fetch('/api/upload-avatar/', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + idToken
          },
          body: formData
        });

        var result = await response.json();

        if (result.success) {
          avatarStatus.textContent = 'Avatar updated!';
          avatarStatus.className = 'avatar-status success';

          // Update UI
          var avatarUrl = result.avatarUrl;
          window.currentAvatarUrl = avatarUrl;
          var escapeHtml = ctx.escapeHtml;

          // Update sessionStorage cache so header stays updated across pages
          try {
            var cacheKey = 'freshwax_user_type_cache';
            var cached = sessionStorage.getItem(cacheKey);
            if (cached) {
              var cacheData = JSON.parse(cached);
              cacheData.avatarUrl = avatarUrl;
              cacheData.timestamp = Date.now();
              sessionStorage.setItem(cacheKey, JSON.stringify(cacheData));
            }
          } catch (e) {
            console.warn('Failed to update avatar cache:', e);
          }

          // Update dashboard header avatar (if exists)
          var userAvatarContainer = document.getElementById('userAvatar');
          if (userAvatarContainer) {
            userAvatarContainer.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="Profile" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">';
            userAvatarContainer.classList.remove('is-pro');
          }

          // Update all header avatars (mobile and desktop from Header.astro)
          document.querySelectorAll('.account-avatar').forEach(function(avatar) {
            var icon = avatar.querySelector('.account-avatar-icon');
            var initial = avatar.querySelector('.account-avatar-initial');
            var img = avatar.querySelector('.account-avatar-img');

            if (icon) icon.classList.add('fwx-hidden');
            if (initial) initial.classList.add('fwx-hidden');
            if (img) {
              img.src = avatarUrl;
              img.classList.remove('fwx-hidden');
            }
          });

          // Update profile preview
          var avatarInitialLarge = document.getElementById('avatarInitialLarge');
          var avatarImageLarge = document.getElementById('avatarImageLarge');
          var removeAvatarBtn = document.getElementById('removeAvatarBtn');
          var avatarPreviewLarge = document.getElementById('avatarPreviewLarge');

          if (avatarInitialLarge) avatarInitialLarge.classList.add('hidden');
          if (avatarImageLarge) {
            avatarImageLarge.src = avatarUrl;
            avatarImageLarge.classList.remove('hidden');
          }
          if (removeAvatarBtn) removeAvatarBtn.classList.remove('hidden');
          if (avatarPreviewLarge) {
            avatarPreviewLarge.classList.remove('is-pro');
          }

          setTimeout(function() {
            avatarStatus.textContent = '';
          }, 3000);
        } else {
          avatarStatus.textContent = result.error || 'Upload failed';
          avatarStatus.className = 'avatar-status error';
        }
      } catch (error) {
        console.error('Avatar upload error:', error);
        avatarStatus.textContent = 'Upload failed. Please try again.';
        avatarStatus.className = 'avatar-status error';
      }

      // Reset input
      avatarUploadInput.value = '';
    });
  }

  // Remove avatar handler
  var removeAvatarBtn = document.getElementById('removeAvatarBtn');
  if (removeAvatarBtn) {
    removeAvatarBtn.addEventListener('click', async function() {
      var currentUser = ctx.getCurrentUser();
      if (!currentUser) return;

      var avatarStatus = document.getElementById('avatarUploadStatus');
      avatarStatus.textContent = 'Removing...';
      avatarStatus.className = 'avatar-status uploading';

      try {
        // Get idToken for Firestore write authentication
        var idToken = await currentUser.getIdToken();

        var response = await fetch('/api/upload-avatar/', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + idToken
          },
          body: JSON.stringify({ userId: currentUser.uid })
        });

        var result = await response.json();

        if (result.success) {
          avatarStatus.textContent = 'Avatar removed';
          avatarStatus.className = 'avatar-status success';
          window.currentAvatarUrl = null;

          // Get display name initial
          var displayName = document.getElementById('displayName')?.value ||
                           document.getElementById('firstName')?.value || 'U';
          var initial = displayName.charAt(0).toUpperCase();

          // Update sessionStorage cache
          try {
            var cacheKey = 'freshwax_user_type_cache';
            var cached = sessionStorage.getItem(cacheKey);
            if (cached) {
              var cacheData = JSON.parse(cached);
              cacheData.avatarUrl = null;
              cacheData.timestamp = Date.now();
              sessionStorage.setItem(cacheKey, JSON.stringify(cacheData));
            }
          } catch (e) {
            console.warn('Failed to update avatar cache:', e);
          }

          // Update dashboard header avatar (if exists)
          var userAvatarContainer = document.getElementById('userAvatar');
          if (userAvatarContainer) {
            userAvatarContainer.innerHTML = '<span id="avatarInitial">' + initial + '</span>';
            if (window.userIsPro) {
              userAvatarContainer.classList.add('is-pro');
            }
          }

          // Update all header avatars (mobile and desktop from Header.astro)
          document.querySelectorAll('.account-avatar').forEach(function(avatar) {
            var icon = avatar.querySelector('.account-avatar-icon');
            var initialEl = avatar.querySelector('.account-avatar-initial');
            var img = avatar.querySelector('.account-avatar-img');

            if (icon) icon.classList.add('fwx-hidden');
            if (img) img.classList.add('fwx-hidden');
            if (initialEl) {
              initialEl.textContent = initial;
              initialEl.classList.remove('fwx-hidden');
            }
          });

          // Update profile preview
          var avatarInitialLarge = document.getElementById('avatarInitialLarge');
          var avatarImageLarge = document.getElementById('avatarImageLarge');
          var avatarPreviewLarge = document.getElementById('avatarPreviewLarge');

          if (avatarInitialLarge) {
            avatarInitialLarge.textContent = initial;
            avatarInitialLarge.classList.remove('hidden');
          }
          if (avatarImageLarge) avatarImageLarge.classList.add('hidden');
          removeAvatarBtn.classList.add('hidden');

          if (avatarPreviewLarge) {
            if (window.userIsPro) {
              avatarPreviewLarge.classList.add('is-pro');
            }
          }

          setTimeout(function() {
            avatarStatus.textContent = '';
          }, 3000);
        } else {
          avatarStatus.textContent = result.error || 'Failed to remove';
          avatarStatus.className = 'avatar-status error';
        }
      } catch (error) {
        console.error('Remove avatar error:', error);
        avatarStatus.textContent = 'Failed to remove. Please try again.';
        avatarStatus.className = 'avatar-status error';
      }
    });
  }

  // Initialize delete account functionality
  initDeleteAccount();

  // Initialize download data functionality
  initDownloadData();
}

// Delete account functionality
function initDeleteAccount() {
  var deleteBtn = document.getElementById('deleteAccountBtn');
  var modal = document.getElementById('deleteModal');
  var cancelBtn = document.getElementById('cancelDeleteBtn');
  var confirmBtn = document.getElementById('confirmDeleteBtn');
  var confirmInput = document.getElementById('confirmDeleteInput');

  if (!deleteBtn || !modal) return;

  // Open modal
  deleteBtn.addEventListener('click', function() {
    modal.classList.remove('hidden');
    confirmInput.value = '';
    confirmBtn.disabled = true;
  });

  // Close modal
  cancelBtn?.addEventListener('click', function() {
    modal.classList.add('hidden');
  });

  // Click outside to close
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  // Enable/disable confirm button based on input
  confirmInput?.addEventListener('input', function() {
    var isValid = confirmInput.value.toLowerCase() === 'delete';
    confirmBtn.disabled = !isValid;
  });

  // Handle delete
  confirmBtn?.addEventListener('click', async function() {
    var currentUser = ctx.getCurrentUser();
    if (!currentUser || confirmInput.value.toLowerCase() !== 'delete') return;

    confirmBtn.textContent = 'Deleting...';
    confirmBtn.classList.add('deleting');
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      // Call delete account API (with idToken for GDPR-compliant deletion)
      var idToken = await currentUser.getIdToken();
      var response = await fetch('/api/delete-account/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.uid, idToken: idToken })
      });

      var result = await response.json();

      if (result.success) {
        // Sign out and redirect
        await ctx.signOut(ctx.auth);
        window.location.href = '/login/?deleted=true';
      } else {
        throw new Error(result.error || 'Failed to delete account');
      }
    } catch (error) {
      console.error('Delete account error:', error);
      confirmBtn.textContent = 'Error - Try Again';
      confirmBtn.classList.remove('deleting');
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;

      setTimeout(function() {
        confirmBtn.textContent = 'Delete Account';
      }, 3000);
    }
  });
}

// Download data functionality
function initDownloadData() {
  var downloadBtn = document.getElementById('downloadDataBtn');
  var modal = document.getElementById('downloadDataModal');
  var cancelBtn = document.getElementById('cancelDownloadBtn');
  var confirmBtn = document.getElementById('confirmDownloadBtn');
  var musicList = document.getElementById('musicDownloadsList');
  var mixesList = document.getElementById('mixesDownloadsList');
  var mixesSection = document.getElementById('djMixesSection');

  // GDPR personal data export
  var gdprBtn = document.getElementById('gdprExportBtn');
  var gdprStatus = document.getElementById('gdprExportStatus');
  gdprBtn?.addEventListener('click', async function() {
    var currentUser = ctx.getCurrentUser();
    if (!currentUser) return;
    gdprBtn.disabled = true;
    gdprBtn.textContent = 'Exporting...';
    if (gdprStatus) gdprStatus.textContent = '';
    try {
      var idToken = await currentUser.getIdToken();
      var res = await fetch('/api/user/export-data/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.uid, idToken: idToken })
      });
      if (!res.ok) throw new Error('Export failed');
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'freshwax-data-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (gdprStatus) gdprStatus.textContent = 'Downloaded!';
    } catch (e) {
      console.error('GDPR export error:', e);
      if (gdprStatus) gdprStatus.textContent = 'Export failed. Try again.';
    } finally {
      gdprBtn.disabled = false;
      gdprBtn.textContent = 'Export Personal Data (JSON)';
    }
  });

  if (!downloadBtn || !modal) return;

  var userMixes = [];
  var purchasedItems = [];

  // Open modal and load content
  downloadBtn.addEventListener('click', async function() {
    modal.classList.remove('hidden');
    loadDownloadableContent();
  });

  // Close modal
  cancelBtn?.addEventListener('click', function() {
    modal.classList.add('hidden');
  });

  // Click outside to close
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  // Toggle all buttons
  document.querySelectorAll('.toggle-all-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var section = btn.dataset.section;
      var container = section === 'music' ? musicList : mixesList;
      var checkboxes = container.querySelectorAll('input[type="checkbox"]');
      var allChecked = Array.from(checkboxes).every(function(cb) { return cb.checked; });
      checkboxes.forEach(function(cb) { cb.checked = !allChecked; });
      btn.textContent = allChecked ? 'Select All' : 'Deselect All';
      updateDownloadButton();
    });
  });

  var escapeHtml = ctx.escapeHtml;

  async function loadDownloadableContent() {
    var currentUser = ctx.getCurrentUser();
    var orders = ctx.getOrders();

    // Load purchased music from orders
    purchasedItems = [];
    var releaseGroups = {};

    if (orders && orders.length > 0) {
      orders.forEach(function(order, orderIdx) {
        if (order.items) {
          order.items.forEach(function(item, itemIdx) {
            // Check if this is merch - be thorough
            var isMerchType = item.type === 'merch' || item.type === 'merchandise';
            var hasMerchId = (item.releaseId && item.releaseId.startsWith('merch_')) ||
                             (item.productId && item.productId.startsWith('merch_')) ||
                             (item.id && String(item.id).startsWith('merch_'));
            var hasMerchAttributes = !!(item.size || item.color);

            var isMerch = isMerchType || hasMerchId || (hasMerchAttributes && !item.downloads);

            if (isMerch) {
              return;
            }

            // Check if this is a music item
            var hasDownloadsObj = !!item.downloads;
            var hasDownloadTracks = item.downloads?.tracks?.length > 0;
            var isDigitalType = item.type === 'digital' || item.type === 'release' || item.type === 'track';
            var hasReleaseId = !!item.releaseId;
            var hasProductId = !!item.productId;

            var isMusic = hasDownloadsObj || hasDownloadTracks || isDigitalType || hasReleaseId || hasProductId;

            if (isMusic) {
              // Use releaseId as group key to combine tracks from same release
              var groupKey = item.releaseId || item.productId || ((item.id || item.name || item.title) + '-' + (order.orderId) + '-' + itemIdx);

              if (!releaseGroups[groupKey]) {
                var artistName = item.downloads?.artistName || item.artist || item.artistName || 'Unknown Artist';
                var releaseName = item.downloads?.releaseName || item.name || item.title || item.releaseName || 'Unknown Release';

                releaseGroups[groupKey] = {
                  id: groupKey,
                  title: releaseName,
                  artist: artistName,
                  releaseId: item.releaseId || item.productId || item.id,
                  orderId: order.orderId || order.id,
                  purchaseDate: order.createdAt || order.date,
                  formats: ['WAV', 'MP3'],
                  hasArtwork: item.downloads?.artworkUrl || item.image || item.artworkUrl || item.coverUrl,
                  tracks: item.downloads?.tracks ? [...item.downloads.tracks] : []
                };
              } else {
                // Merge tracks from same release (avoid duplicates)
                if (item.downloads?.tracks) {
                  item.downloads.tracks.forEach(function(track) {
                    var trackExists = releaseGroups[groupKey].tracks.some(function(t) { return t.name === track.name; });
                    if (!trackExists) {
                      releaseGroups[groupKey].tracks.push(track);
                    }
                  });
                }
                // Update artwork if not already set
                if (!releaseGroups[groupKey].hasArtwork) {
                  releaseGroups[groupKey].hasArtwork = item.downloads?.artworkUrl || item.image || item.artworkUrl || item.coverUrl;
                }
              }
            }
          });
        }
      });
    }

    // Convert groups to array
    purchasedItems = Object.values(releaseGroups);

    // Render music purchases grouped by release
    if (purchasedItems.length > 0) {
      musicList.innerHTML = purchasedItems.map(function(item, index) {
        var trackCount = item.tracks?.length || 0;
        var trackText = trackCount > 0 ? (' &bull; ' + trackCount + ' track' + (trackCount !== 1 ? 's' : '')) : '';

        return '<label class="download-option">' +
          '<input type="checkbox" data-type="music" data-id="' + (item.releaseId || item.id) + '" data-index="' + index + '" checked />' +
          '<span class="option-check"></span>' +
          '<div class="option-info">' +
            '<strong>' + escapeHtml(item.title) + '</strong>' +
            '<span>' + escapeHtml(item.artist) + trackText + '</span>' +
            '<div class="option-badges">' +
              item.formats.map(function(f) { return '<span class="option-badge audio">' + f + '</span>'; }).join(' ') +
              (item.hasArtwork ? ' <span class="option-badge artwork">Artwork</span>' : '') +
            '</div>' +
          '</div>' +
        '</label>';
      }).join('');
    } else {
      musicList.innerHTML = '<div class="empty-downloads">No music purchases found</div>';
    }

    // Load user's DJ mixes
    try {
      var mixesResponse = await fetch('/api/get-dj-mixes/?userId=' + currentUser.uid);
      var mixesData = await mixesResponse.json();

      if (mixesData.success && mixesData.mixes && mixesData.mixes.length > 0) {
        userMixes = mixesData.mixes;
        mixesSection.style.display = 'block';

        mixesList.innerHTML = userMixes.map(function(mix, index) {
          return '<label class="download-option">' +
            '<input type="checkbox" data-type="mix" data-id="' + mix.id + '" data-index="' + index + '" checked />' +
            '<span class="option-check"></span>' +
            '<div class="option-info">' +
              '<strong>' + escapeHtml(mix.title) + '</strong>' +
              '<span>' + (mix.plays || 0) + ' plays</span>' +
              '<div class="option-badges">' +
                '<span class="option-badge mix">DJ Mix</span>' +
              '</div>' +
            '</div>' +
          '</label>';
        }).join('');
      } else {
        mixesSection.style.display = 'none';
      }
    } catch (e) {
      console.error('Error loading mixes:', e);
      mixesSection.style.display = 'none';
    }

    // Add event listeners to checkboxes
    modal.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.addEventListener('change', updateDownloadButton);
    });

    updateDownloadButton();
  }

  function updateDownloadButton() {
    var anyChecked = modal.querySelectorAll('input[type="checkbox"]:checked').length > 0;
    confirmBtn.disabled = !anyChecked;
  }

  // Handle download
  confirmBtn?.addEventListener('click', async function() {
    var currentUser = ctx.getCurrentUser();
    var orders = ctx.getOrders();
    if (!currentUser) return;

    var selected = {
      ordersPdf: document.getElementById('downloadOrdersPdf')?.checked || false,
      music: [],
      mixes: []
    };

    // Collect selected music
    modal.querySelectorAll('input[data-type="music"]:checked').forEach(function(cb) {
      var index = parseInt(cb.dataset.index);
      if (purchasedItems[index]) {
        selected.music.push(purchasedItems[index]);
      }
    });

    // Collect selected mixes
    modal.querySelectorAll('input[data-type="mix"]:checked').forEach(function(cb) {
      var index = parseInt(cb.dataset.index);
      if (userMixes[index]) {
        selected.mixes.push(userMixes[index]);
      }
    });

    var totalItems = (selected.ordersPdf ? 1 : 0) + selected.music.length + selected.mixes.length;
    if (totalItems === 0) return;

    confirmBtn.textContent = 'Preparing...';
    confirmBtn.disabled = true;

    try {
      var downloadCount = 0;

      // Download order history PDF
      if (selected.ordersPdf && orders.length > 0) {
        confirmBtn.textContent = 'Downloading PDF...';
        await downloadOrdersPdf();
        downloadCount++;
      }

      // Download selected music files
      for (var mi = 0; mi < selected.music.length; mi++) {
        var item = selected.music[mi];
        confirmBtn.textContent = 'Downloading ' + (downloadCount + 1) + '/' + totalItems + '...';

        // Download each track in the release
        if (item.tracks && item.tracks.length > 0) {
          for (var ti = 0; ti < item.tracks.length; ti++) {
            var track = item.tracks[ti];
            // Download WAV version
            if (track.wavUrl || track.url) {
              var wavUrl = track.wavUrl || track.url;
              var wavFilename = item.artist + ' - ' + track.name + '.wav';
              window.open('/api/download/?url=' + encodeURIComponent(wavUrl) + '&filename=' + encodeURIComponent(wavFilename), '_blank');
              await new Promise(function(r) { setTimeout(r, 800); });
            }
            // Download MP3 version if available
            if (track.mp3Url) {
              var mp3Filename = item.artist + ' - ' + track.name + '.mp3';
              window.open('/api/download/?url=' + encodeURIComponent(track.mp3Url) + '&filename=' + encodeURIComponent(mp3Filename), '_blank');
              await new Promise(function(r) { setTimeout(r, 800); });
            }
          }
        }

        // Download artwork if available
        if (item.hasArtwork) {
          var artworkUrl = typeof item.hasArtwork === 'string' ? item.hasArtwork : null;
          if (artworkUrl) {
            var dlExt = artworkUrl.split('.').pop() || 'jpg';
            var artFilename = item.artist + ' - ' + item.title + ' - Artwork.' + dlExt;
            window.open('/api/download/?url=' + encodeURIComponent(artworkUrl) + '&filename=' + encodeURIComponent(artFilename), '_blank');
            await new Promise(function(r) { setTimeout(r, 500); });
          }
        }

        downloadCount++;
      }

      // Download selected DJ mixes
      for (var xi = 0; xi < selected.mixes.length; xi++) {
        var mix = selected.mixes[xi];
        confirmBtn.textContent = 'Downloading ' + (downloadCount + 1) + '/' + totalItems + '...';
        if (mix.audioUrl || mix.url) {
          var mixUrl = mix.audioUrl || mix.url;
          var mixFilename = (mix.title || 'DJ Mix') + '.mp3';
          window.open('/api/download/?url=' + encodeURIComponent(mixUrl) + '&filename=' + encodeURIComponent(mixFilename), '_blank');
        }
        downloadCount++;
        await new Promise(function(r) { setTimeout(r, 500); });
      }

      confirmBtn.textContent = 'Done!';
      setTimeout(function() {
        modal.classList.add('hidden');
        confirmBtn.textContent = 'Download Selected';
        confirmBtn.disabled = false;
      }, 1500);

    } catch (error) {
      console.error('Download error:', error);
      confirmBtn.textContent = 'Error - Try Again';
      setTimeout(function() {
        confirmBtn.textContent = 'Download Selected';
        confirmBtn.disabled = false;
      }, 2000);
    }
  });

  function downloadOrdersPdf() {
    // Generate PDF content
    var pdfContent = generateOrdersPdfHtml();

    // Open print dialog for PDF
    var printWindow = window.open('', '_blank');
    printWindow.document.write(pdfContent);
    printWindow.document.close();
    printWindow.focus();
    return new Promise(function(resolve) {
      setTimeout(function() {
        printWindow.print();
        resolve();
      }, 500);
    });
  }

  function escPdf(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function generateOrdersPdfHtml() {
    var orders = ctx.getOrders();
    var customerData = ctx.getCustomerData();
    var currentUser = ctx.getCurrentUser();

    var fullName = customerData?.displayName ||
                   (customerData?.firstName && customerData?.lastName ?
                    (customerData.firstName + ' ' + customerData.lastName) :
                    customerData?.firstName || 'Customer');
    var email = currentUser?.email || '';

    // Helper to create human-readable order ID
    function formatOrderId(order, index) {
      // If there's an orderNumber field, use it
      if (order.orderNumber) return order.orderNumber;

      // Create a friendly ID from date + last 4 chars
      var date = new Date(order.createdAt || order.date);
      var dateStr = date.toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
      var suffix = (order.orderId || order.id || '0000').slice(-4).toUpperCase();
      return 'FW-' + dateStr + '-' + suffix;
    }

    var orderRows = orders.map(function(order, index) {
      return '<tr>' +
        '<td>' + escPdf(formatOrderId(order, index)) + '</td>' +
        '<td>' + new Date(order.createdAt || order.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + '</td>' +
        '<td>' + escPdf((order.items || []).map(function(i) { return i.title || i.name; }).join(', ') || 'N/A') + '</td>' +
        '<td>&pound;' + (order.total || 0).toFixed(2) + '</td>' +
        '<td>' + escPdf(order.status || order.orderStatus || 'Completed') + '</td>' +
      '</tr>';
    }).join('');

    return '<!DOCTYPE html>' +
      '<html>' +
      '<head>' +
        '<title>Fresh Wax - Order History</title>' +
        '<style>' +
          'body { font-family: Arial, sans-serif; padding: 40px; }' +
          '.header { text-align: center; margin-bottom: 30px; }' +
          '.logo { font-size: 42px; font-weight: bold; margin-bottom: 10px; }' +
          '.logo .fresh { color: #fff; }' +
          '.logo .wax { color: #dc2626; }' +
          '.order-history-title { font-size: 28px; color: #333; margin: 20px 0 10px 0; }' +
          '.customer-info { color: #d1d5db; font-size: 14px; margin-bottom: 5px; }' +
          '.generated { color: #999; font-size: 12px; margin-bottom: 30px; }' +
          'table { width: 100%; border-collapse: collapse; margin-top: 20px; }' +
          'th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }' +
          'th { background: linear-gradient(to bottom, #000000, #111827); font-weight: bold; }' +
          '.footer { margin-top: 40px; text-align: center; color: #999; font-size: 12px; }' +
        '</style>' +
      '</head>' +
      '<body>' +
        '<div class="header">' +
          '<div class="logo"><span class="fresh">Fresh</span> <span class="wax">Wax</span></div>' +
          '<div class="order-history-title">Order History</div>' +
          '<p class="customer-info"><strong>' + escPdf(fullName) + '</strong></p>' +
          '<p class="customer-info">' + escPdf(email) + '</p>' +
          '<p class="generated">Generated: ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + '</p>' +
        '</div>' +
        '<table>' +
          '<thead>' +
            '<tr>' +
              '<th scope="col">Order ID</th>' +
              '<th scope="col">Date</th>' +
              '<th scope="col">Items</th>' +
              '<th scope="col">Total</th>' +
              '<th scope="col">Status</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            (orderRows || '<tr><td colspan="5">No orders found</td></tr>') +
          '</tbody>' +
        '</table>' +
        '<p class="footer">Total Orders: ' + orders.length + ' | freshwax.co.uk</p>' +
      '</body>' +
      '</html>';
  }
}
