// One-off: strip takeover-related code from the minified
// public/dj-lobby-pusher.js. After this runs, all DM/chat/presence
// behaviour is preserved; only takeover request/approve/decline +
// related Pusher event bindings + helper functions are removed.
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '..', 'public', 'dj-lobby-pusher.js');
let src = fs.readFileSync(file, 'utf8');
const before = src.length;

// Helper that walks balanced braces from an offset that points at `{`.
function endOfBlock(s, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Walk a balanced-brace block back from a known anchor, optionally
// stripping a leading 'export async function' / 'function' prefix.
function dropFn(s, name) {
  // Match: export async function NAME( ... ){...}  OR  function NAME( ... ){...}
  const re = new RegExp(`(export\\s+async\\s+function|function)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(s);
  if (!m) return s;
  const braceStart = m.index + m[0].length - 1;
  const braceEnd = endOfBlock(s, braceStart);
  if (braceEnd < 0) return s;
  return s.slice(0, m.index) + s.slice(braceEnd + 1);
}

// 1. Remove Pusher event bindings for takeover events.
// privateChannel.bind("takeover-XYZ", e => { ... }) — bodies can contain
// nested () so a regex won't reliably match the closer; walk balanced parens.
function stripBind(s, channelName, eventName) {
  const needle = `${channelName}.bind("${eventName}",`;
  while (true) {
    const i = s.indexOf(needle);
    if (i === -1) return s;
    // Find the closing ) that balances the bind() call.
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    // Eat trailing comma/semicolon if present so we don't leave dangling syntax.
    while (s[j] === ',' || s[j] === ';') j++;
    // If we just removed the last item in a comma-chain, the leading comma
    // would be left dangling before a `}` or `)`. Eat it backwards too.
    let i2 = i;
    if (s[i2 - 1] === ',') {
      // Look ahead past trimmed whitespace for a closing brace/paren.
      let k = j;
      while (s[k] === ' ' || s[k] === '\n') k++;
      if (s[k] === '}' || s[k] === ')') i2--;
    }
    s = s.slice(0, i2) + s.slice(j);
  }
}
for (const ev of ['takeover-requested', 'takeover-approved']) {
  src = stripBind(src, 'lobbyChannel', ev);
}
for (const ev of ['takeover-request', 'takeover-approved', 'takeover-declined', 'takeover-cancelled']) {
  src = stripBind(src, 'privateChannel', ev);
}

// 2. Remove the checkTakeoverStatus() call from loadInitialData's Promise.all.
src = src.replace(/,checkTakeoverStatus\(\)/g, '');

// 3. Remove the module-scope state declarations.
src = src.replace(/let takeoverCountdownInterval=null,incomingTakeoverCountdownInterval=null;/, '');
src = src.replace(/const TAKEOVER_TIMEOUT_SECONDS=\d+;/, '');

// 4. Drop the takeover functions (export + internal helpers).
const fns = [
  'requestTakeover',
  'approveTakeover',
  'declineTakeover',
  'startTakeoverCountdown',
  'stopTakeoverCountdown',
  'showIncomingTakeover',
  'hideIncomingTakeover',
  'startIncomingTakeoverCountdown',
  'stopIncomingTakeoverCountdown',
  'showTakeoverApproved',
  'checkTakeoverStatus',
];
for (const name of fns) src = dropFn(src, name);

// 5. Sanity check — no takeover symbols should remain.
const left = (src.match(/[Tt]akeover/g) || []).length;
console.log(`Removed ${before - src.length} bytes, ${left} takeover refs remaining`);
fs.writeFileSync(file, src);
