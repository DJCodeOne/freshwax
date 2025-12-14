// Script to fix all API files to properly init Firebase for Cloudflare
const fs = require('fs');
const path = require('path');

// Files that need fixing (have write ops but no initFirebaseEnv)
const filesToFix = [
  'src/pages/api/admin/approve-partner.ts',
  'src/pages/api/admin/bypass-requests.ts',
  'src/pages/api/admin/dj-moderation.ts',
  'src/pages/api/admin/giftcards.ts',
  'src/pages/api/admin/lobby-bypass.ts',
  'src/pages/api/admin/reject-partner.ts',
  'src/pages/api/admin/reset-store.ts',
  'src/pages/api/admin/update-order-status.ts',
  'src/pages/api/admin/update-partner.ts',
  'src/pages/api/dj/eligibility.ts',
  'src/pages/api/dj-lobby/takeover.ts',
  'src/pages/api/giftcards/balance.ts',
  'src/pages/api/giftcards/credit-account.ts',
  'src/pages/api/giftcards/generate.ts',
  'src/pages/api/giftcards/purchase.ts',
  'src/pages/api/giftcards/redeem.ts',
  'src/pages/api/livestream/allowances.ts',
  'src/pages/api/livestream/chat.ts',
  'src/pages/api/livestream/chat-cleanup.ts',
  'src/pages/api/livestream/check-relays.ts',
  'src/pages/api/livestream/listeners.ts',
  'src/pages/api/livestream/manage.ts',
  'src/pages/api/livestream/react.ts',
  'src/pages/api/livestream/red5-webhook.ts',
  'src/pages/api/livestream/relay-sources.ts',
  'src/pages/api/livestream/slots.ts',
  'src/pages/api/livestream/switchover.ts',
  'src/pages/api/livestream/validate-stream.ts',
  'src/pages/api/newsletter/send.ts',
  'src/pages/api/newsletter/subscribe.ts',
  'src/pages/api/newsletter/subscribers.ts',
  'src/pages/api/newsletter/unsubscribe.ts',
  'src/pages/api/roles/manage.ts',
  'src/pages/api/stream/dj-settings.ts',
  'src/pages/api/stream/end.ts',
  'src/pages/api/add-comment.ts',
  'src/pages/api/add-mix-comment.ts',
  'src/pages/api/bookings.ts',
  'src/pages/api/create-order.ts',
  'src/pages/api/delete-account.ts',
  'src/pages/api/delete-merch.ts',
  'src/pages/api/delete-mix.ts',
  'src/pages/api/follow-artist.ts',
  'src/pages/api/gift-cards.ts',
  'src/pages/api/process-order.ts',
  'src/pages/api/rate-release.ts',
  'src/pages/api/reports.ts',
  'src/pages/api/suppliers.ts',
  'src/pages/api/test-firebase.ts',
  'src/pages/api/track-mix-download.ts',
  'src/pages/api/track-mix-like.ts',
  'src/pages/api/track-mix-play.ts',
  'src/pages/api/track-mix-unlike.ts',
  'src/pages/api/update-merch.ts',
  'src/pages/api/update-mix.ts',
  'src/pages/api/update-mix-artwork.ts',
  'src/pages/api/update-partner.ts',
  'src/pages/api/update-stock.ts',
  'src/pages/api/upload-avatar.ts',
  'src/pages/api/upload-merch.ts',
  'src/pages/api/upload-mix.ts',
  'src/pages/api/wishlist.ts',
];

// Also fix JS files with incorrect initFirebaseEnv
const jsFilesToFix = [
  'src/pages/api/fix-release-status.js',
  'src/pages/api/publish-releases.js',
  'src/pages/api/update-master-json.js',
];

const initCode = `
// Initialize Firebase for Cloudflare runtime
function initFirebase(locals) {
  const env = (locals)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}
`;

let fixed = 0;
let errors = 0;

for (const file of filesToFix) {
  try {
    let content = fs.readFileSync(file, 'utf8');

    // Check if already has initFirebaseEnv import
    if (!content.includes('initFirebaseEnv')) {
      // Add to import
      content = content.replace(
        /from ['"](.+?)firebase-rest['"]/,
        `from '$1firebase-rest'`
      );

      // Find the firebase-rest import and add initFirebaseEnv
      content = content.replace(
        /(import\s*\{[^}]*)(}\s*from\s*['"][^'"]*firebase-rest['"])/,
        '$1, initFirebaseEnv $2'
      );
    }

    // Add locals to handler parameters if not present
    // Match POST, GET, PUT, DELETE, PATCH handlers
    const handlerPatterns = [
      /export\s+(const|async function)\s+(GET|POST|PUT|DELETE|PATCH)\s*[=:]\s*async\s*\(\s*\{\s*request\s*\}\s*\)/g,
      /export\s+(const|async function)\s+(GET|POST|PUT|DELETE|PATCH)\s*[=:]\s*async\s*\(\s*\{\s*request,\s*url\s*\}\s*\)/g,
      /export\s+(const|async function)\s+(GET|POST|PUT|DELETE|PATCH)\s*[=:]\s*async\s*\(\s*\{\s*url\s*\}\s*\)/g,
    ];

    // Add locals parameter
    content = content.replace(
      /(\s*)(export\s+(?:const|async function)\s+(?:GET|POST|PUT|DELETE|PATCH)\s*[=:]\s*async\s*\(\s*\{)(\s*request)/g,
      '$1$2$3, locals'
    );

    content = content.replace(
      /(\s*)(export\s+(?:const|async function)\s+(?:GET|POST|PUT|DELETE|PATCH)\s*[=:]\s*async\s*\(\s*\{)(\s*url)/g,
      '$1$2 locals,$3'
    );

    // Add initFirebase call at start of handler
    if (!content.includes('initFirebaseEnv({')) {
      // Find the try block or first line of handler body and add init
      content = content.replace(
        /(export\s+(?:const|async function)\s+(?:GET|POST|PUT|DELETE|PATCH)[^{]*\{)(\s*)(try\s*\{|const|let|\/\/)/,
        `$1$2const env = (locals as any)?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });

  $3`
      );
    }

    fs.writeFileSync(file, content);
    console.log(`Fixed: ${file}`);
    fixed++;
  } catch (err) {
    console.error(`Error fixing ${file}:`, err.message);
    errors++;
  }
}

// Fix JS files with incorrect pattern
for (const file of jsFilesToFix) {
  try {
    let content = fs.readFileSync(file, 'utf8');

    // Replace incorrect initFirebaseEnv call
    content = content.replace(
      /initFirebaseEnv\(import\.meta\.env\)/g,
      `initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  })`
    );

    // Add locals parameter and env extraction if not present
    if (!content.includes('locals?.runtime?.env') && !content.includes('(locals)?.runtime?.env')) {
      content = content.replace(
        /(export\s+async\s+function\s+(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*\{)(\s*request)/g,
        '$1$2, locals'
      );

      content = content.replace(
        /(export\s+async\s+function\s+(?:GET|POST|PUT|DELETE|PATCH)[^{]*\{)(\s*)(\/\/|initFirebaseEnv)/,
        `$1$2const env = locals?.runtime?.env;
  $3`
      );
    }

    fs.writeFileSync(file, content);
    console.log(`Fixed JS: ${file}`);
    fixed++;
  } catch (err) {
    console.error(`Error fixing ${file}:`, err.message);
    errors++;
  }
}

console.log(`\nDone: ${fixed} files fixed, ${errors} errors`);
