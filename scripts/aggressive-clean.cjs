const fs = require('fs');

const deadDjLobby = new Set(['anim-drop','anim-flip','anim-glitch','anim-slam','anim-spin','audio-relay-info','audio-relay-source','book-slot-link','bypass-or-divider','capture-icon','capture-share-compact','capture-share-row','capture-share-section','capture-thumb-btn','chat-column','chat-header-actions','chat-hint','chat-input-area','chat-input-section','chat-input-wrapper','chat-messages','clear-thumb-btn','close-go-live-btn','close-success-btn','connecting-spinner','connecting-state','connection-status','control-label','copy-btn-blue','countdown-number','countdown-number-container','countdown-text','credentials-cell','credentials-row-split','current-dj-avatar','dj-is-live-indicator','emoji-grid','emoji-picker','error-icon','error-state','eye-icon','facebook-btn','final-countdown','gif-grid','gif-modal-box','go-live-modal','go-live-modal-body','go-live-modal-content','go-live-modal-header','go-live-modal-overlay','go-live-step','grid-cell','health-actions','health-live-indicator','health-stat','health-stats','info-grid','info-item','info-label','info-row','info-value','inline-stream-info','key-dots','key-header','key-icon','key-not-available','large','live-indicator-content','live-led-glow','live-led-text','live-pulse','live-state','live-stats','live-word','lobby-audio-live-badge','lobby-audio-placeholder','lobby-live-text','lock-icon','ls-chat-badge','ls-chat-empty','ls-chat-empty-icon','ls-chat-empty-text','message-avatar','multi-stream-arrow','multi-stream-box','multi-stream-grid','multi-stream-link','multi-stream-settings-btn','mute-btn-small','my-stream-controls','next-slot-info','no-viewers-msg','obs-instructions','obs-instructions-compact','obs-setup-section','output-blue','output-field-compact','output-url-hint','output-url-wrapper','peak-ppm-row','player-control-btn','player-controls','player-controls-center','preview-header','pro-badge','pro-badge-inline','pro-badge-sm','pro-feature','pulse','ready-hint','ready-section','ready-status','rec-card','relay-field-compact','relay-info-card','relay-input-wrapper','relay-instructions','relay-output-row','relay-select-btn','relay-source-hint','relay-station-desc','relay-station-header','relay-station-icon','relay-station-status','relay-url-display','result-value','retest-btn','retry-btn','setup-icon','share-buttons','share-icon-btn','share-input-row','share-post-compact','social-post-input','source-desc','source-icon','source-option','source-options','spawn-icon','speed-modal-body','speed-modal-content','speed-results-grid','start-test-btn','status-value','step-actions','step-desc','step-indicator','step-instructions','step-line','step-number','stream-credentials','stream-health','stream-info-display','stream-info-inputs','stream-info-panel','stream-key-input-wrapper','stream-source-selector','stream-stats-container','thumbnail-preview','toggle-visibility-btn','twitch-field','twitch-field-compact','twitch-fields','twitch-header','twitch-hint','twitch-icon','twitch-optional','twitch-row','twitch-settings-section','twitter-btn','unlocked','unlocked-icon','viewer-avatar','viewer-item','viewer-name','viewers-column','viewers-count','viewers-dot','viewers-header','viewers-list','viz-bar','volume-control','volume-control-inline','volume-slider','volume-slider-horizontal','volume-slider-wrapper']);

const deadLive = new Set(['access-code-error','access-code-input','access-code-success','add-to-playlist-btn','anim-toggle-btn','audio-bar','audio-dj-name','audio-live-badge','audio-relay-info','audio-relay-source','audio-show-title','audio-viz-bar','audio-waveform','avg-rating','bass-btn','brand-logo','butt-audio-preview','calendar-card','calendar-grid','calendar-nav','chat-form','chat-gif','chat-gif-wrap','chat-hint','chat-input-area','chat-input-container','chat-input-section','chat-input-wrapper','chat-section','chat-send-btn','chat-sender','chat-text','chat-tool-btn','chat-tools','chat-viewers','chat-welcome','clap-btn','clear-queue-btn','close-btn','control-btn','control-btn-large','deny','dj-name','eligibility-actions','eligibility-content','eligibility-desc','eligibility-divider','eligibility-header','eligibility-icon','eligibility-loading','eligibility-modal-content','eligibility-requirements','empty-schedule','explosion-btn','export-formats','export-modal-content','fire-btn','fist-btn','footer-divider','form-row','format-option','fs-audio-dj-name','fs-audio-live-badge','fs-audio-relay-info','fs-audio-relay-source','fs-audio-show-title','fs-live-pulse','full-schedule-btn','fullpage-btn','fullscreen-btn','gif-grid','gif-modal-box','inline-btn','inline-controls','inline-rating','inline-reactions','input-button-group','is-playlist','like-btn','likes-bar','likes-progress','listener-badge','listener-count','listeners-card','listeners-list','live-badge-small','live-dj-ends','live-dj-info','live-dj-name','live-dot-small','live-footer','live-grid','live-indicator','live-page','live-pulse','live-status-card','live-video-container','login-prompt','medium','message-avatar','message-name','message-text','mini-avatar','mini-controls','mini-dj','mini-expand-btn','mini-led','mini-led-strip','mini-play-btn','mini-player','mini-player-info','mini-progress','mini-status','mini-text','my-playlist-actions','my-playlist-column','my-playlist-grid','my-playlist-header','my-playlist-section','now-playing-info','pause-icon','personal-add-btn','personal-delete-btn','personal-item-actions','personal-item-info','personal-item-meta','personal-item-thumb','personal-item-title','personal-playlist-item','play-btn','play-pause-btn','player-btn','player-controls-bar','playlist-add-section','playlist-auth-notice','playlist-columns','playlist-controls','playlist-controls-inner','playlist-empty','playlist-empty-hint','playlist-error','playlist-grid-item','playlist-grid-thumb','playlist-input-group','playlist-item','playlist-item-info','playlist-item-number','playlist-item-platform','playlist-item-remove','playlist-item-thumb','playlist-item-thumb-placeholder','playlist-item-title','playlist-item-url','playlist-modal','playlist-modal-backdrop','playlist-modal-body','playlist-modal-content','playlist-modal-header','playlist-modal-large','playlist-queue','playlist-queue-grid','playlist-queue-header','playlist-sort-select','playlist-status','playlist-success','playlist-url-input','playlist-video-wrapper','pro-locked','pulse-dot','queue-card','queue-column','queue-count','queue-preview-side','queue-split-container','quick-access-section','reaction-emoji','reaction-float','reactions-bar','record-btn','record-control','record-dot','record-duration','record-text','recording','redeem-btn','relay-badge','req-icon','req-info','req-status','req-title','requirement-item','rocket-btn','save-btn','schedule-btn-arrow','schedule-btn-icon','schedule-btn-label','schedule-btn-sub','schedule-btn-text','schedule-crew','schedule-dj-avatar','schedule-duration','schedule-duration-pill','schedule-duration-val','schedule-meta','schedule-section','schedule-separator','schedule-status','schedule-time-block','schedule-time-val','shoutout-scroll-text','sidebar-card-header','sidebar-column','star-btn','stream-chat-grid','stream-dj','stream-meta','stream-title','takeover-approve-btns','takeover-notification-lobby','time-legend','time-legend-dot','time-legend-item','title-relay-from','today-card','tonearm-left','tonearm-right','tool-btn','upload-mix-btn','video-player-wrapper','video-wrapper','viewer-count','vinyl-avatar','vinyl-label','visualizer-bar','volume-control','volume-slider','w3','week-label']);

function isSelectorDead(selector, deadClasses) {
  const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.every(c => deadClasses.has(c));
}

function aggressiveClean(filePath, deadClasses) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;
  const origLines = css.split('\n').length;

  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let removedLines = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Skip empty lines between rules (collapse later)
    // Check if this is a selector line (starts with . or contains . and ends with { or ,)
    const isSelector = trimmed.match(/^[.#a-zA-Z\[\*:>+~]/) && !trimmed.startsWith('@') && !trimmed.startsWith('/*');

    if (isSelector) {
      // Collect the full selector (may span multiple lines with commas)
      let selectorLines = [i];
      let j = i;
      let selectorText = trimmed;

      // If line ends with comma, next lines are part of selector
      while (selectorText.endsWith(',') && j + 1 < lines.length) {
        j++;
        selectorLines.push(j);
        selectorText += ' ' + lines[j].trim();
      }

      // Check if the last line has a {
      const braceIdx = selectorText.indexOf('{');
      if (braceIdx >= 0) {
        const selPart = selectorText.substring(0, braceIdx);
        const selectors = selPart.split(',').map(s => s.trim()).filter(s => s);
        const allDead = selectors.length > 0 && selectors.every(s => isSelectorDead(s, deadClasses));

        if (allDead) {
          // Find the closing brace
          let depth = 0;
          let endLine = i;
          for (let k = i; k <= j || depth > 0; k++) {
            if (k >= lines.length) break;
            for (const ch of lines[k]) {
              if (ch === '{') depth++;
              if (ch === '}') depth--;
            }
            endLine = k;
            if (depth <= 0) break;
          }
          const removed = endLine - i + 1;
          removedLines += removed;
          i = endLine + 1;
          continue;
        }
      } else if (selectorText.endsWith(',')) {
        // Selector ending with comma but no brace found - check next non-empty line
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && lines[k].includes('{')) {
          const fullSel = selectorText + ' ' + lines[k].trim();
          const brIdx = fullSel.indexOf('{');
          if (brIdx >= 0) {
            const selPart2 = fullSel.substring(0, brIdx);
            const selectors2 = selPart2.split(',').map(s => s.trim()).filter(s => s);
            const allDead2 = selectors2.length > 0 && selectors2.every(s => isSelectorDead(s, deadClasses));
            if (allDead2) {
              let depth = 0;
              let endLine = i;
              for (let m = i; m < lines.length; m++) {
                for (const ch of lines[m]) {
                  if (ch === '{') depth++;
                  if (ch === '}') depth--;
                }
                endLine = m;
                if (depth <= 0 && m >= k) break;
              }
              removedLines += (endLine - i + 1);
              i = endLine + 1;
              continue;
            }
          }
        }
      }
    }

    output.push(lines[i]);
    i++;
  }

  // Collapse triple+ blank lines
  let result = output.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  // Remove empty media queries
  result = result.replace(/@media[^{]+\{\s*\}/g, '');

  // Remove orphaned comments (comment followed only by blank lines until next comment or end)
  const finalLines = result.split('\n');
  const cleaned = [];
  for (let k = 0; k < finalLines.length; k++) {
    const t = finalLines[k].trim();
    // Check for orphaned single-line comments
    if (t.startsWith('/*') && t.endsWith('*/') && !t.includes('@')) {
      // Look ahead - if next non-blank line is another comment or closing brace, this is orphaned
      let next = k + 1;
      while (next < finalLines.length && finalLines[next].trim() === '') next++;
      if (next >= finalLines.length || finalLines[next].trim().startsWith('/*') || finalLines[next].trim() === '}') {
        // Skip this orphaned comment
        continue;
      }
    }
    cleaned.push(finalLines[k]);
  }

  result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  const newSize = result.length;
  const newLines = result.split('\n').length;

  console.log(filePath + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (removed ' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origSize + ' -> ' + newSize + ' (saved ' + (origSize - newSize) + ')');
  console.log('  Removed rule lines: ' + removedLines);

  fs.writeFileSync(filePath, result);
}

aggressiveClean('src/styles/dj-lobby.css', deadDjLobby);
aggressiveClean('src/styles/live.css', deadLive);
