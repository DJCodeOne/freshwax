const fs = require('fs');

// === Dead keyframes to remove ===
const deadKeyframesDjLobby = new Set(['countdownSpin','countdownSlam','countdownFlip','countdownDrop','countdownGlitch','countdownRing','burstPulse','led-pulse','dotsCycle','viewerPulse','viewerDotPulse']);
const deadKeyframesLive = new Set(['record-pulse']);

// === Dead classes for each file ===
const deadDjLobby = new Set(['anim-drop','anim-flip','anim-glitch','anim-slam','anim-spin','audio-relay-info','audio-relay-source','book-slot-link','bypass-or-divider','capture-icon','capture-share-compact','capture-share-row','capture-share-section','capture-thumb-btn','chat-column','chat-header-actions','chat-hint','chat-input-area','chat-input-section','chat-input-wrapper','chat-messages','clear-thumb-btn','close-go-live-btn','close-success-btn','connecting-spinner','connecting-state','connection-status','control-label','copy-btn-blue','countdown-number','countdown-number-container','countdown-text','credentials-cell','credentials-row-split','current-dj-avatar','dj-is-live-indicator','emoji-grid','emoji-picker','error-icon','error-state','eye-icon','facebook-btn','final-countdown','gif-grid','gif-modal-box','go-live-modal','go-live-modal-body','go-live-modal-content','go-live-modal-header','go-live-modal-overlay','go-live-step','grid-cell','health-actions','health-live-indicator','health-stat','health-stats','info-grid','info-item','info-label','info-row','info-value','inline-stream-info','key-dots','key-header','key-icon','key-not-available','large','live-indicator-content','live-led-glow','live-led-text','live-pulse','live-state','live-stats','live-word','lobby-audio-live-badge','lobby-audio-placeholder','lobby-live-text','lock-icon','ls-chat-badge','ls-chat-empty','ls-chat-empty-icon','ls-chat-empty-text','message-avatar','multi-stream-arrow','multi-stream-box','multi-stream-grid','multi-stream-link','multi-stream-settings-btn','mute-btn-small','my-stream-controls','next-slot-info','no-viewers-msg','obs-instructions','obs-instructions-compact','obs-setup-section','output-blue','output-field-compact','output-url-hint','output-url-wrapper','peak-ppm-row','player-control-btn','player-controls','player-controls-center','preview-header','pro-badge','pro-badge-inline','pro-badge-sm','pro-feature','pulse','ready-hint','ready-section','ready-status','rec-card','relay-field-compact','relay-info-card','relay-input-wrapper','relay-instructions','relay-output-row','relay-select-btn','relay-source-hint','relay-station-desc','relay-station-header','relay-station-icon','relay-station-status','relay-url-display','result-value','retest-btn','retry-btn','setup-icon','share-buttons','share-icon-btn','share-input-row','share-post-compact','social-post-input','source-desc','source-icon','source-option','source-options','spawn-icon','speed-modal-body','speed-modal-content','speed-results-grid','start-test-btn','status-value','step-actions','step-desc','step-indicator','step-instructions','step-line','step-number','stream-credentials','stream-health','stream-info-display','stream-info-inputs','stream-info-panel','stream-key-input-wrapper','stream-source-selector','stream-stats-container','thumbnail-preview','toggle-visibility-btn','twitch-field','twitch-field-compact','twitch-fields','twitch-header','twitch-hint','twitch-icon','twitch-optional','twitch-row','twitch-settings-section','twitter-btn','unlocked','unlocked-icon','viewer-avatar','viewer-item','viewer-name','viewers-column','viewers-count','viewers-dot','viewers-header','viewers-list','viz-bar','volume-control','volume-control-inline','volume-slider','volume-slider-horizontal','volume-slider-wrapper']);

const deadLive = new Set(['access-code-error','access-code-input','access-code-success','add-to-playlist-btn','anim-toggle-btn','audio-bar','audio-dj-name','audio-live-badge','audio-relay-info','audio-relay-source','audio-show-title','audio-viz-bar','audio-waveform','avg-rating','bass-btn','brand-logo','butt-audio-preview','calendar-card','calendar-grid','calendar-nav','chat-form','chat-gif','chat-gif-wrap','chat-hint','chat-input-area','chat-input-container','chat-input-section','chat-input-wrapper','chat-section','chat-send-btn','chat-sender','chat-text','chat-tool-btn','chat-tools','chat-viewers','chat-welcome','clap-btn','clear-queue-btn','close-btn','control-btn','control-btn-large','deny','dj-name','eligibility-actions','eligibility-content','eligibility-desc','eligibility-divider','eligibility-header','eligibility-icon','eligibility-loading','eligibility-modal-content','eligibility-requirements','empty-schedule','explosion-btn','export-formats','export-modal-content','fire-btn','fist-btn','footer-divider','form-row','format-option','fs-audio-dj-name','fs-audio-live-badge','fs-audio-relay-info','fs-audio-relay-source','fs-audio-show-title','fs-live-pulse','full-schedule-btn','fullpage-btn','fullscreen-btn','gif-grid','gif-modal-box','inline-btn','inline-controls','inline-rating','inline-reactions','input-button-group','is-playlist','like-btn','likes-bar','likes-progress','listener-badge','listener-count','listeners-card','listeners-list','live-badge-small','live-dj-ends','live-dj-info','live-dj-name','live-dot-small','live-footer','live-grid','live-indicator','live-page','live-pulse','live-status-card','live-video-container','login-prompt','medium','message-avatar','message-name','message-text','mini-avatar','mini-controls','mini-dj','mini-expand-btn','mini-led','mini-led-strip','mini-play-btn','mini-player','mini-player-info','mini-progress','mini-status','mini-text','my-playlist-actions','my-playlist-column','my-playlist-grid','my-playlist-header','my-playlist-section','now-playing-info','pause-icon','personal-add-btn','personal-delete-btn','personal-item-actions','personal-item-info','personal-item-meta','personal-item-thumb','personal-item-title','personal-playlist-item','play-btn','play-pause-btn','player-btn','player-controls-bar','playlist-add-section','playlist-auth-notice','playlist-columns','playlist-controls','playlist-controls-inner','playlist-empty','playlist-empty-hint','playlist-error','playlist-grid-item','playlist-grid-thumb','playlist-input-group','playlist-item','playlist-item-info','playlist-item-number','playlist-item-platform','playlist-item-remove','playlist-item-thumb','playlist-item-thumb-placeholder','playlist-item-title','playlist-item-url','playlist-modal','playlist-modal-backdrop','playlist-modal-body','playlist-modal-content','playlist-modal-header','playlist-modal-large','playlist-queue','playlist-queue-grid','playlist-queue-header','playlist-sort-select','playlist-status','playlist-success','playlist-url-input','playlist-video-wrapper','pro-locked','pulse-dot','queue-card','queue-column','queue-count','queue-preview-side','queue-split-container','quick-access-section','reaction-emoji','reaction-float','reactions-bar','record-btn','record-control','record-dot','record-duration','record-text','recording','redeem-btn','relay-badge','req-icon','req-info','req-status','req-title','requirement-item','rocket-btn','save-btn','schedule-btn-arrow','schedule-btn-icon','schedule-btn-label','schedule-btn-sub','schedule-btn-text','schedule-crew','schedule-dj-avatar','schedule-duration','schedule-duration-pill','schedule-duration-val','schedule-meta','schedule-section','schedule-separator','schedule-status','schedule-time-block','schedule-time-val','shoutout-scroll-text','sidebar-card-header','sidebar-column','star-btn','stream-chat-grid','stream-dj','stream-meta','stream-title','takeover-approve-btns','takeover-notification-lobby','time-legend','time-legend-dot','time-legend-item','title-relay-from','today-card','tonearm-left','tonearm-right','tool-btn','upload-mix-btn','video-player-wrapper','video-wrapper','viewer-count','vinyl-avatar','vinyl-label','visualizer-bar','volume-control','volume-slider','w3','week-label']);

function isSelectorDead(selector, deadClasses) {
  const classes = [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
  if (classes.length === 0) return false;
  return classes.every(c => deadClasses.has(c));
}

function deepClean(filePath, deadClasses, deadKeyframes) {
  let css = fs.readFileSync(filePath, 'utf8');
  const origSize = css.length;
  const origLines = css.split('\n').length;

  // 1. Remove dead @keyframes blocks
  for (const kf of deadKeyframes) {
    // Match @keyframes name { ... } including nested braces
    const regex = new RegExp('@keyframes\\s+' + kf.replace(/-/g, '\\-') + '\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}', 'g');
    css = css.replace(regex, '');
  }

  // 2. Find and remove dead rules that are INSIDE media queries
  // Parse the CSS and look for dead selectors inside @media blocks
  const lines = css.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for dead selectors (standalone rules inside media queries)
    const classMatch = trimmed.match(/^\.([a-zA-Z][\w-]*)/);
    if (classMatch && isSelectorDead(trimmed.replace(/\s*\{.*$/, '').replace(/,\s*$/, ''), deadClasses)) {
      // Check if this line is a dead rule
      if (trimmed.endsWith('{') || trimmed.endsWith(',')) {
        // Collect the full selector
        let selectorEnd = i;
        while (selectorEnd < lines.length && !lines[selectorEnd].includes('{')) {
          selectorEnd++;
        }

        // Check if ALL selectors in the group are dead
        let selectorText = '';
        for (let k = i; k <= selectorEnd && k < lines.length; k++) {
          selectorText += lines[k] + '\n';
        }
        const braceIdx = selectorText.indexOf('{');
        if (braceIdx >= 0) {
          const selPart = selectorText.substring(0, braceIdx);
          const selectors = selPart.split(',').map(s => s.trim()).filter(s => s);
          const allDead = selectors.every(s => isSelectorDead(s, deadClasses));

          if (allDead) {
            // Skip the entire rule
            let depth = 0;
            for (let k = i; k < lines.length; k++) {
              for (const ch of lines[k]) {
                if (ch === '{') depth++;
                if (ch === '}') depth--;
              }
              if (depth <= 0) {
                i = k + 1;
                break;
              }
            }
            continue;
          }
        }
      }
    }

    // Check for dangling selectors ending with comma followed by empty line then }
    if (trimmed.endsWith(',') && trimmed.match(/\.[a-zA-Z]/)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim() === '}') {
        // Check if this selector is dead
        const selectors = trimmed.replace(/,\s*$/, '').split(',').map(s => s.trim());
        if (selectors.every(s => isSelectorDead(s, deadClasses))) {
          i++; // Skip this dead dangling selector
          continue;
        }
      }
    }

    output.push(line);
    i++;
  }

  // 3. Remove orphaned comments (comment followed by blank lines where the next rule was removed)
  let result = output.join('\n');

  // 4. Clean up consecutive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  // 5. Remove empty media queries
  result = result.replace(/@media[^{]+\{\s*\}/g, '');

  const newSize = result.length;
  const newLines = result.split('\n').length;

  console.log(filePath + ':');
  console.log('  Lines: ' + origLines + ' -> ' + newLines + ' (removed ' + (origLines - newLines) + ')');
  console.log('  Bytes: ' + origSize + ' -> ' + newSize + ' (saved ' + (origSize - newSize) + ')');

  fs.writeFileSync(filePath, result);
}

deepClean('src/styles/dj-lobby.css', deadDjLobby, deadKeyframesDjLobby);
deepClean('src/styles/live.css', deadLive, deadKeyframesLive);
