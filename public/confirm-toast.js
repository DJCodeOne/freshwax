// public/confirm-toast.js
// Branded dialogs that replace the browser's plain alert() / confirm() /
// prompt() popups. Plain ES5: loaded as a classic script on every page (via
// Layout.astro and AdminLayout.astro) and by pages with their own <html> shell.
//
// window.showConfirmToast(message, opts) -> Promise<boolean>
//   true = confirmed; false = cancelled (button, Escape, backdrop click)
// window.showPromptToast(message, opts) -> Promise<string|null>
//   the entered text, or null when cancelled (same contract as prompt())
//   opts.defaultValue, opts.placeholder, opts.required (disables OK while empty)
// Shared opts: confirmText, cancelText, detail (smaller line under the message,
//   "\n" for breaks), danger:false (green button instead of red)
// window.showToast(message, type) -> void   ('success' | 'error' | 'info')
//   defined here only when the page doesn't already have one (the layouts do).
//
// Never overwrites existing functions: the DJ lobby defines a richer
// showConfirmToast (countdown) with the same API.
(function () {
  if (typeof window === 'undefined') return;

  function ensureStyles() {
    if (document.getElementById('fw-confirm-toast-style')) return;
    var st = document.createElement('style');
    st.id = 'fw-confirm-toast-style';
    st.textContent = '@keyframes fwConfirmFade{from{opacity:0}to{opacity:1}}@keyframes fwConfirmPop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}';
    document.head.appendChild(st);
  }

  // One dialog builder for confirm and prompt. Resolves via onDone(value).
  function openDialog(message, opts, withInput, onDone) {
    opts = opts || {};
    var old = document.getElementById('fw-confirm-toast');
    if (old) old.remove();
    ensureStyles();

    var back = document.createElement('div');
    back.id = 'fw-confirm-toast';
    back.setAttribute('role', 'alertdialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', message);
    back.style.cssText = 'position:fixed;inset:0;z-index:10010;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(ellipse at 50% 30%,rgba(125,28,28,.28),transparent 60%),rgba(0,0,0,.66);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:fwConfirmFade .18s ease-out;';

    var card = document.createElement('div');
    card.style.cssText = 'background:linear-gradient(160deg,#2a1212,#100707);color:#fff;padding:28px 30px;border-radius:18px;border:1px solid #dc2626;box-shadow:0 24px 70px rgba(0,0,0,.7),0 0 30px rgba(220,38,38,.18);display:flex;flex-direction:column;gap:22px;width:100%;max-width:440px;text-align:center;animation:fwConfirmPop .22s cubic-bezier(.2,.9,.3,1.25);';

    var msg = document.createElement('div');
    msg.textContent = message;
    msg.style.cssText = 'font-weight:700;font-size:1.35rem;line-height:1.3;white-space:pre-line;';
    card.appendChild(msg);

    if (opts.detail) {
      var det = document.createElement('div');
      det.textContent = opts.detail;
      det.style.cssText = 'margin-top:-8px;font-size:.98rem;line-height:1.5;color:#f0d6d6;white-space:pre-line;';
      card.appendChild(det);
    }

    var input = null;
    if (withInput) {
      input = document.createElement('input');
      input.type = 'text';
      input.value = opts.defaultValue == null ? '' : String(opts.defaultValue);
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.setAttribute('aria-label', message);
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid rgba(220,38,38,.45);background:#0b0505;color:#fff;font-size:1rem;outline:none;';
      card.appendChild(input);
    }

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = opts.cancelText || 'Cancel';
    cancelBtn.style.cssText = 'flex:1;padding:14px 18px;border-radius:12px;border:1px solid rgba(220,38,38,.4);background:rgba(40,18,18,.9);color:#f0e3e3;font-weight:600;font-size:1rem;cursor:pointer;';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = opts.confirmText || (withInput ? 'OK' : 'Confirm');
    var accent = opts.danger === false ? '#16a34a' : '#dc2626';
    var glow = opts.danger === false ? 'rgba(22,163,74,.45)' : 'rgba(220,38,38,.45)';
    okBtn.style.cssText = 'flex:1;padding:14px 18px;border-radius:12px;border:0;background:' + accent + ';color:#fff;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 6px 22px ' + glow + ';';

    function syncRequired() {
      if (!input || !opts.required) return;
      var empty = !input.value.trim();
      okBtn.disabled = empty;
      okBtn.style.opacity = empty ? '0.5' : '1';
      okBtn.style.cursor = empty ? 'not-allowed' : 'pointer';
    }

    var done = false;
    function finish(ok) {
      if (done) return;
      if (ok && input && opts.required && !input.value.trim()) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      onDone(ok, input ? input.value : null);
    }
    function onKey(e) {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && input && document.activeElement === input) { e.preventDefault(); finish(true); }
    }
    cancelBtn.addEventListener('click', function () { finish(false); });
    okBtn.addEventListener('click', function () { finish(true); });
    back.addEventListener('click', function (e) { if (e.target === back) finish(false); });
    document.addEventListener('keydown', onKey);
    if (input) input.addEventListener('input', syncRequired);

    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    card.appendChild(row);
    back.appendChild(card);
    document.body.appendChild(back);
    syncRequired();
    if (input) { input.focus(); input.select(); } else { okBtn.focus(); }
  }

  if (!window.showConfirmToast) {
    window.showConfirmToast = function (message, opts) {
      return new Promise(function (resolve) {
        openDialog(message, opts, false, function (ok) { resolve(ok); });
      });
    };
  }

  if (!window.showPromptToast) {
    window.showPromptToast = function (message, opts) {
      return new Promise(function (resolve) {
        openDialog(message, opts, true, function (ok, value) { resolve(ok ? value : null); });
      });
    };
  }

  if (!window.showToast) {
    var ICONS = { success: '✓', error: '✕', info: 'ℹ' };
    var COLORS = { success: '#16a34a', error: '#dc2626', info: '#3b82f6' };
    var hideTimer = null;
    window.showToast = function (msg, type) {
      type = (type === 'error' || type === 'info') ? type : 'success';
      var old = document.getElementById('fw-toast');
      if (old) old.remove();
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      var accent = COLORS[type];
      var t = document.createElement('div');
      t.id = 'fw-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      t.style.cssText = 'position:fixed;bottom:84px;left:50%;transform:translate(-50%,16px);display:flex;align-items:center;gap:10px;max-width:min(92vw,420px);background:rgba(17,17,17,0.96);color:#fff;padding:12px 18px 12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);border-left:4px solid ' + accent + ';font-size:14px;font-weight:600;line-height:1.4;z-index:10020;box-shadow:0 8px 24px rgba(0,0,0,0.45);opacity:0;transition:opacity .25s ease,transform .25s ease;white-space:pre-line;';
      var icon = document.createElement('span');
      icon.textContent = ICONS[type];
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = 'flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;background:' + accent + ';';
      var text = document.createElement('span');
      text.textContent = msg;
      t.appendChild(icon);
      t.appendChild(text);
      document.body.appendChild(t);
      requestAnimationFrame(function () { requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'translate(-50%,0)'; }); });
      hideTimer = setTimeout(function () {
        t.style.opacity = '0';
        t.style.transform = 'translate(-50%,10px)';
        setTimeout(function () { t.remove(); }, 260);
      }, 3600);
    };
  }
})();
