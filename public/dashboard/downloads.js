// Dashboard — downloads module
// Handles file downloads, ZIP creation, and download rendering

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var ctx = null;

export function init(context) {
  ctx = context;
}

// Download status modal helpers
export function updateDownloadModal(filename, status, progressPct) {
  var modal = document.getElementById('downloadStatusModal');
  var titleEl = document.getElementById('dlStatusTitle');
  var filenameEl = document.getElementById('dlStatusFilename');
  var textEl = document.getElementById('dlStatusText');
  var iconEl = document.getElementById('dlStatusIcon');
  var progressWrap = document.getElementById('dlProgressWrap');
  var progressFill = document.getElementById('dlProgressFill');
  if (!modal) return;
  if (filename !== undefined) filenameEl.textContent = filename || '';

  if (status === 'preparing') {
    titleEl.textContent = 'Preparing Download';
    textEl.textContent = 'Authorizing...';
    progressWrap.style.display = 'none';
    iconEl.innerHTML = '<svg class="dl-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/></svg>';
  } else if (status === 'downloading') {
    titleEl.textContent = 'Downloading';
    progressWrap.style.display = 'block';
    iconEl.innerHTML = '<svg class="dl-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>';
    if (typeof progressPct === 'number' && progressPct >= 0) {
      progressFill.style.width = Math.min(progressPct, 100) + '%';
      textEl.textContent = Math.round(progressPct) + '% downloaded';
    } else {
      progressFill.style.width = '0%';
      progressFill.classList.add('dl-progress-indeterminate');
      textEl.textContent = 'Downloading...';
    }
  } else if (status === 'done') {
    titleEl.textContent = 'Download Complete';
    textEl.textContent = 'File saved successfully';
    progressWrap.style.display = 'block';
    progressFill.style.width = '100%';
    progressFill.classList.remove('dl-progress-indeterminate');
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
  } else if (status === 'error') {
    titleEl.textContent = 'Download Failed';
    textEl.textContent = 'Please try again';
    progressWrap.style.display = 'none';
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
  }
  modal.classList.remove('hidden');
}

export function hideDownloadModal() {
  var modal = document.getElementById('downloadStatusModal');
  if (modal) modal.classList.add('hidden');
  var fill = document.getElementById('dlProgressFill');
  if (fill) fill.classList.remove('dl-progress-indeterminate');
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Download via same-origin streaming endpoint with progress tracking
export async function downloadFile(downloadInfo, filename, button) {
  var originalText = button.innerHTML;
  button.classList.add('downloading');
  button.innerHTML = 'Downloading...';
  updateDownloadModal(filename, 'preparing');

  try {
    var orderId = downloadInfo.orderId;
    var releaseId = downloadInfo.releaseId;
    var trackIndex = downloadInfo.trackIndex;
    var fileType = downloadInfo.fileType;

    // Get Firebase auth token
    var user = ctx.auth?.currentUser;
    if (!user) {
      throw new Error('Please sign in to download');
    }
    var token = await user.getIdToken();

    // Stream file from same-origin API (no CORS issues, supports progress)
    var params = new URLSearchParams({
      orderId: orderId,
      releaseId: releaseId,
      trackIndex: String(trackIndex),
      fileType: fileType,
      filename: filename || 'download'
    });

    updateDownloadModal(filename, 'downloading', -1);

    var dlController = new AbortController();
    var dlTimeout = setTimeout(function() { dlController.abort(); }, 30000);
    var fileResponse = await fetch('/api/download-file/?' + params.toString(), {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: dlController.signal
    });
    clearTimeout(dlTimeout);

    if (!fileResponse.ok) {
      var errBody = await fileResponse.json().catch(function() { return {}; });
      throw new Error(errBody.error || 'Download failed: ' + fileResponse.status);
    }

    var contentLength = fileResponse.headers.get('Content-Length');
    var totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    var blob;

    if (totalBytes && fileResponse.body) {
      // Stream with real progress
      var reader = fileResponse.body.getReader();
      var receivedBytes = 0;
      var chunks = [];

      while (true) {
        var result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
        receivedBytes += result.value.length;
        var pct = (receivedBytes / totalBytes) * 100;
        updateDownloadModal(undefined, 'downloading', pct);
        var dlText = document.getElementById('dlStatusText');
        if (dlText) dlText.textContent = Math.round(pct) + '% — ' + formatBytes(receivedBytes) + ' / ' + formatBytes(totalBytes);
      }

      blob = new Blob(chunks);
    } else {
      // No Content-Length — download without progress
      blob = await fileResponse.blob();
    }

    // Trigger save via blob URL (same-origin so download attribute works)
    var blobUrl = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 1000);

    updateDownloadModal(filename, 'done');
    button.innerHTML = originalText;
    button.classList.remove('downloading');
    setTimeout(hideDownloadModal, 2500);

  } catch (error) {
    console.error('Download error:', error);
    updateDownloadModal(filename, 'error');
    button.innerHTML = originalText;
    button.classList.remove('downloading');
    setTimeout(hideDownloadModal, 3000);
  }
}

// Download ZIP containing all tracks and artwork
export async function downloadZip(button) {
  var orderId = button.dataset.orderId;
  var releaseId = button.dataset.releaseId;
  var releaseName = button.dataset.releaseName;
  var artistName = button.dataset.artist;
  var artworkUrl = button.dataset.artworkUrl;
  var tracks = [];
  try {
    tracks = JSON.parse(button.dataset.tracks || '[]');
  } catch (e) {
    console.error('Failed to parse tracks:', e);
  }

  // Show progress modal
  var modal = document.getElementById('zipProgressModal');
  var progressFill = document.getElementById('zipProgressFill');
  var progressText = document.getElementById('zipProgressText');
  var fileList = document.getElementById('zipFileList');
  var closeBtn = document.getElementById('zipModalClose');
  var originalText = button.innerHTML;

  // Create abort controller for cancellation
  var abortController = new AbortController();
  var isCancelled = false;

  // Cancel handler
  var cancelHandler = function() {
    isCancelled = true;
    abortController.abort();
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    progressFill.style.width = '0%';
    progressFill.classList.remove('creating');
    progressFill.style.background = '';
    button.innerHTML = originalText;
    button.classList.remove('downloading');
  };
  closeBtn?.addEventListener('click', cancelHandler, { once: true });

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  progressFill.style.width = '0%';
  progressFill.classList.remove('creating');
  progressText.textContent = 'Verifying purchase...';
  fileList.innerHTML = '';

  button.classList.add('downloading');
  button.innerHTML = 'Creating ZIP...';

  try {
    // Get Firebase auth token
    var user = ctx.auth?.currentUser;
    if (!user) {
      throw new Error('Please sign in to download');
    }
    var token = await user.getIdToken();

    progressText.textContent = 'Preparing download...';

    // Build list of files to download via /api/download-file/ (R2 native binding)
    var filesToDownload = [];

    // Add artwork if available
    if (artworkUrl) {
      var artworkExt = artworkUrl.split('.').pop()?.split('?')[0] || 'jpg';
      filesToDownload.push({
        trackIndex: 0,
        fileType: 'artwork',
        filename: releaseName + ' - Artwork.' + artworkExt,
        label: 'Artwork'
      });
    }

    // Add all tracks (MP3 and WAV)
    tracks.forEach(function(track, idx) {
      var trackName = artistName ? (artistName + ' - ' + track.name) : track.name;
      if (track.mp3Url) {
        filesToDownload.push({
          trackIndex: idx,
          fileType: 'mp3',
          filename: trackName + '.mp3',
          label: track.name + ' (MP3)'
        });
      }
      if (track.wavUrl) {
        filesToDownload.push({
          trackIndex: idx,
          fileType: 'wav',
          filename: trackName + '.wav',
          label: track.name + ' (WAV)'
        });
      }
    });

    if (filesToDownload.length === 0) {
      throw new Error('No files available to download');
    }

    // Initialize JSZip - dynamically load if not available
    if (typeof JSZip === 'undefined') {
      progressText.textContent = 'Loading ZIP library...';
      await new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.crossOrigin = 'anonymous';
        script.onload = resolve;
        script.onerror = function() { reject(new Error('Failed to load ZIP library')); };
        document.head.appendChild(script);
      });
    }
    var zip = new window.JSZip();
    var folder = zip.folder(releaseName);

    // Download each file and add to ZIP (80% of progress for downloads)
    var completed = 0;
    var successCount = 0;
    var downloadProgressWeight = 80; // 80% for downloads, 20% for ZIP creation

    for (var fi = 0; fi < filesToDownload.length; fi++) {
      var file = filesToDownload[fi];
      // Check if cancelled
      if (isCancelled) {
        throw new Error('Download cancelled');
      }

      // Update progress UI - base progress for this file
      var basePercent = Math.round((completed / filesToDownload.length) * downloadProgressWeight);
      progressFill.style.width = basePercent + '%';
      progressText.textContent = 'Downloading ' + file.label + '... ' + basePercent + '%';

      // Add to file list
      var listItem = document.createElement('div');
      listItem.className = 'zip-file-item';
      listItem.innerHTML = '<span class="zip-file-icon">⏳</span> ' + escapeHtml(file.label);
      listItem.id = 'zip-file-' + completed;
      fileList.appendChild(listItem);

      try {
        // Use R2 native streaming endpoint (same-origin, auth via orderId)
        var dlParams = new URLSearchParams({
          orderId: orderId,
          releaseId: releaseId,
          trackIndex: String(file.trackIndex),
          fileType: file.fileType,
          filename: file.filename
        });
        var fileResponse = await fetch('/api/download-file/?' + dlParams.toString(), {
          signal: abortController.signal,
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!fileResponse.ok) {
          throw new Error('HTTP ' + fileResponse.status);
        }

        // Stream the response with progress tracking
        var contentLength = fileResponse.headers.get('content-length');
        var totalSize = contentLength ? parseInt(contentLength, 10) : 0;

        var receivedBytes = 0;
        var chunks = [];
        var reader = fileResponse.body?.getReader();

        if (reader && totalSize > 0) {
          while (true) {
            var readResult = await reader.read();
            if (readResult.done) break;
            chunks.push(readResult.value);
            receivedBytes += readResult.value.length;

            // Update progress within this file's allocation
            var fileProgress = receivedBytes / totalSize;
            var overallPercent = Math.round(basePercent + (fileProgress * (downloadProgressWeight / filesToDownload.length)));
            progressFill.style.width = overallPercent + '%';
            progressText.textContent = 'Downloading ' + file.label + '... ' + overallPercent + '%';
          }

          // Combine chunks into blob
          var fileBlob = new Blob(chunks);
          folder.file(file.filename, fileBlob);
        } else {
          // Fallback if streaming not available
          var fallbackBlob = await fileResponse.blob();
          folder.file(file.filename, fallbackBlob);
        }

        successCount++;

        // Update list item to show success
        var itemEl = document.getElementById('zip-file-' + completed);
        if (itemEl) {
          itemEl.innerHTML = '<span class="zip-file-icon" style="color: #22c55e;">✓</span> ' + escapeHtml(file.label);
        }
      } catch (fileError) {
        if (fileError.name === 'AbortError' || isCancelled) {
          throw new Error('Download cancelled');
        }
        console.error('Error downloading ' + file.label + ':', fileError);
        var errEl = document.getElementById('zip-file-' + completed);
        if (errEl) {
          errEl.innerHTML = '<span class="zip-file-icon" style="color: #ef4444;">✗</span> ' + escapeHtml(file.label) + ' - Failed';
        }
      }

      completed++;
    }

    // Check if cancelled or no files downloaded
    if (isCancelled) {
      throw new Error('Download cancelled');
    }
    if (successCount === 0) {
      throw new Error('Failed to download any files');
    }

    // Generate ZIP with animation
    progressText.textContent = 'Creating ZIP file...';
    progressFill.style.width = '80%';
    progressFill.classList.add('creating');

    var zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }, function(metadata) {
      // 80% to 100% during ZIP generation
      var zipPercent = 80 + (metadata.percent * 0.2);
      progressFill.style.width = Math.round(zipPercent) + '%';
    });

    progressFill.classList.remove('creating');

    // Trigger download
    progressFill.style.width = '100%';
    progressText.textContent = 'Download ready!';

    var downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(zipBlob);
    downloadLink.download = releaseName + '.zip';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(downloadLink.href);

    button.innerHTML = '✓ Done!';
    closeBtn?.removeEventListener('click', cancelHandler);
    setTimeout(function() {
      button.innerHTML = originalText;
      button.classList.remove('downloading');
      progressFill.style.width = '0%';
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }, 2000);

  } catch (error) {
    // Clean up animation state
    progressFill.classList.remove('creating');

    // If cancelled, just clean up silently (already handled by cancelHandler)
    if (isCancelled || (error instanceof Error && error.message === 'Download cancelled')) {
      return;
    }

    console.error('ZIP download error:', error);
    progressText.textContent = 'Error: ' + (error instanceof Error ? error.message : 'Unknown error');
    progressFill.style.background = '#ef4444';

    button.innerHTML = '✗ Error';
    setTimeout(function() {
      button.innerHTML = originalText;
      button.classList.remove('downloading');
      progressFill.style.background = '';
      progressFill.style.width = '0%';
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }, 3000);
  }
}

// Render downloads from orders
export function renderDownloads(ordersList) {
  var container = document.getElementById('downloadsContainer');
  if (!container) return;

  // Extract all digital items from orders with orderId for secure downloads
  var allDownloads = [];
  (ordersList || []).forEach(function(order) {
    (order.items || []).forEach(function(item) {
      if (item.downloads?.tracks?.length > 0 || item.type === 'digital' || item.type === 'release' || item.type === 'track' || item.type === 'vinyl') {
        allDownloads.push({
          ...item,
          orderId: order.id, // Include orderId for presigned URL requests
          orderNumber: order.orderNumber,
          orderDate: order.createdAt
        });
      }
    });
  });

  // Group downloads by release to avoid duplicate artwork buttons
  var releaseMap = new Map();

  allDownloads.forEach(function(item) {
    var releaseId = item.releaseId || item.productId || item.id;

    if (releaseMap.has(releaseId)) {
      // Add tracks to existing release group, avoid duplicates
      var existing = releaseMap.get(releaseId);
      if (item.downloads?.tracks) {
        item.downloads.tracks.forEach(function(track) {
          var trackExists = existing.downloads.tracks.some(function(t) { return t.name === track.name; });
          if (!trackExists) {
            existing.downloads.tracks.push(track);
          }
        });
      }
    } else {
      // Create new release group
      releaseMap.set(releaseId, {
        ...item,
        releaseId: releaseId, // Ensure releaseId is stored
        downloads: {
          artistName: item.downloads?.artistName || item.artist || '',
          releaseName: item.downloads?.releaseName || item.name || '',
          artworkUrl: item.downloads?.artworkUrl || item.image || null,
          tracks: item.downloads?.tracks ? [...item.downloads.tracks] : []
        }
      });
    }
  });

  var downloads = Array.from(releaseMap.values());

  if (downloads.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<p style="color: #fff; margin: 0 0 1.5rem 0;">No digital purchases yet</p>' +
        '<a href="/releases/" style="display: inline-block; padding: 0.75rem 1.5rem; background: #dc2626; color: #fff; font-weight: 600; border-radius: 8px; text-decoration: none;">Browse Releases</a>' +
      '</div>';
    return;
  }

  container.innerHTML = downloads.map(function(item) {
    var orderDate = item.orderDate ? new Date(item.orderDate).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    }) : '';

    var artistName = item.downloads?.artistName || item.artist || '';
    var releaseName = item.downloads?.releaseName || item.name || '';
    var displayName = artistName ? artistName + ' - ' + releaseName : releaseName;
    var artExt = (item.downloads?.artworkUrl || '').split('.').pop() || 'jpg';
    var artworkFilename = artistName ? artistName + ' - ' + releaseName + ' - Artwork.' + artExt : releaseName + ' - Artwork.' + artExt;

    var orderId = item.orderId;
    var releaseId = item.releaseId;

    var trackRows = (item.downloads?.tracks || []).map(function(track, idx) {
      var trackFilename = artistName
        ? artistName + ' - ' + track.name + ' - ' + releaseName
        : track.name;

      return '<div class="track-row">' +
        '<span class="track-name">' +
          '<span class="num">' + String(idx + 1).padStart(2, '0') + '</span>' +
          escapeHtml(track.name) +
        '</span>' +
        '<div class="dl-buttons">' +
          (track.mp3Url ?
            '<button type="button" class="dl-btn mp3" data-order-id="' + escapeHtml(orderId) + '" data-release-id="' + escapeHtml(releaseId) + '" data-track-index="' + idx + '" data-file-type="mp3" data-filename="' + escapeHtml(trackFilename) + '.mp3">' +
              '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>' +
              'MP3' +
            '</button>' : '') +
          (track.wavUrl ?
            '<button type="button" class="dl-btn wav" data-order-id="' + escapeHtml(orderId) + '" data-release-id="' + escapeHtml(releaseId) + '" data-track-index="' + idx + '" data-file-type="wav" data-filename="' + escapeHtml(trackFilename) + '.wav">' +
              '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>' +
              'WAV' +
            '</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    var trackCount = item.downloads?.tracks?.length || 0;
    var typeLabel = trackCount === 1 ? 'Single Track' : trackCount + ' Tracks';

    return '<div class="download-card">' +
      '<div class="download-header">' +
        '<img src="' + escapeHtml(item.image || item.downloads?.artworkUrl || '/place-holder.webp') + '" alt="' + escapeHtml(displayName) + '" class="download-art" width="80" height="80" loading="lazy" decoding="async">' +
        '<div class="download-info">' +
          '<h4>' + escapeHtml(displayName) + '</h4>' +
          '<p>' + escapeHtml(typeLabel) + ' &middot; ' + escapeHtml(orderDate) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="release-dl-buttons">' +
        (item.downloads?.artworkUrl ?
          '<button type="button" class="dl-btn art" data-order-id="' + escapeHtml(orderId) + '" data-release-id="' + escapeHtml(releaseId) + '" data-track-index="0" data-file-type="artwork" data-filename="' + escapeHtml(artworkFilename) + '">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>' +
            'Artwork' +
          '</button>' : '') +
        '<button type="button" class="dl-btn zip" data-order-id="' + escapeHtml(orderId) + '" data-release-id="' + escapeHtml(releaseId) + '" data-release-name="' + escapeHtml(displayName) + '" data-tracks=\'' + JSON.stringify(item.downloads?.tracks || []).replace(/'/g, '&#39;') + '\' data-artwork-url="' + escapeHtml(item.downloads?.artworkUrl || '') + '" data-artist="' + escapeHtml(artistName) + '">' +
          '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>' +
          'Download ZIP' +
        '</button>' +
      '</div>' +
      (trackRows ? '<div class="track-list">' + trackRows + '</div>' : '') +
    '</div>';
  }).join('');

  // Attach download handlers using secure presigned URLs (exclude ZIP buttons)
  container.querySelectorAll('.dl-btn[data-order-id]:not(.zip)').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var button = e.currentTarget;
      var downloadInfo = {
        orderId: button.dataset.orderId,
        releaseId: button.dataset.releaseId,
        trackIndex: parseInt(button.dataset.trackIndex, 10),
        fileType: button.dataset.fileType
      };
      var filename = button.dataset.filename || 'download';
      if (downloadInfo.orderId && downloadInfo.releaseId) {
        downloadFile(downloadInfo, filename, button);
      }
    });
  });

  // Attach ZIP download handlers
  container.querySelectorAll('.dl-btn.zip[data-order-id]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      downloadZip(e.currentTarget);
    });
  });
}

// ZIP Modal close functionality
export function initZipModal() {
  var modal = document.getElementById('zipProgressModal');
  var closeBtn = document.getElementById('zipModalClose');
  var backdrop = modal?.querySelector('.zip-modal-backdrop');

  function closeZipModal() {
    modal?.classList.add('hidden');
    document.body.style.overflow = '';
    // Reset progress bar state
    var progressFill = document.getElementById('zipProgressFill');
    if (progressFill) {
      progressFill.style.width = '0%';
      progressFill.style.background = '';
    }
  }

  closeBtn?.addEventListener('click', closeZipModal);
  backdrop?.addEventListener('click', closeZipModal);
}
