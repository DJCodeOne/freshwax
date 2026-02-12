const fs = require('fs');
const path = require('path');

function getAstroFiles(dir) {
  let results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) results = results.concat(getAstroFiles(full));
    else if (item.name.endsWith('.astro')) results.push(full);
  }
  return results;
}

const adminDir = path.join('src', 'pages', 'admin');
const files = getAstroFiles(adminDir);
const toFix = files.filter(f => !f.includes('login.astro'));

let fixedCount = 0;
let skippedCount = 0;

for (const file of toFix) {
  const content = fs.readFileSync(file, 'utf8');

  if (content.includes('requireAdminAuth')) {
    console.log('SKIP (already has auth):', file);
    skippedCount++;
    continue;
  }

  // Calculate relative import path
  const fileDir = path.dirname(file);
  const libDir = path.join('src', 'lib');
  const rel = path.relative(fileDir, libDir).split(path.sep).join('/');
  const importPath = rel + '/admin';

  const lines = content.split('\n');
  const firstDash = lines.indexOf('---');
  if (firstDash === -1) {
    console.log('SKIP (no frontmatter):', file);
    skippedCount++;
    continue;
  }

  const authImport = "import { requireAdminAuth } from '" + importPath + "';";
  const authLines = [
    '',
    '// Server-side admin auth check',
    'const authResult = await requireAdminAuth(Astro.request, Astro.locals);',
    "if (authResult) return Astro.redirect('/login');",
    ''
  ];

  const newLines = [...lines];

  // Check if already imports from admin
  const hasAdminImport = content.includes("from '" + importPath + "'") ||
                          content.includes('from "' + importPath + '"');

  // Find insertion point: after the opening --- line
  let insertIdx = firstDash + 1;

  // Skip past existing comments and imports
  while (insertIdx < newLines.length &&
         newLines[insertIdx] !== '---' &&
         (newLines[insertIdx].trim() === '' ||
          newLines[insertIdx].trim().startsWith('//') ||
          newLines[insertIdx].trim().startsWith('import ') ||
          newLines[insertIdx].trim().startsWith("import'"))) {
    insertIdx++;
  }

  // If we hit the closing ---, insert before it but after imports
  // Otherwise insert at the found position (before first non-import line)

  // Add import if needed
  if (!hasAdminImport) {
    // Find first import or right after ---
    let importInsertIdx = firstDash + 1;
    // Skip initial comments
    while (importInsertIdx < newLines.length &&
           newLines[importInsertIdx] !== '---' &&
           (newLines[importInsertIdx].trim() === '' ||
            newLines[importInsertIdx].trim().startsWith('//'))) {
      importInsertIdx++;
    }
    // Insert import at this position
    newLines.splice(importInsertIdx, 0, authImport);
    insertIdx++; // Adjust for inserted line
  }

  // Now insert auth check after all imports
  // Re-scan to find position after all imports
  let authInsertIdx = firstDash + 1;
  while (authInsertIdx < newLines.length &&
         newLines[authInsertIdx] !== '---' &&
         (newLines[authInsertIdx].trim() === '' ||
          newLines[authInsertIdx].trim().startsWith('//') ||
          newLines[authInsertIdx].trim().startsWith('import '))) {
    authInsertIdx++;
  }

  newLines.splice(authInsertIdx, 0, ...authLines);

  fs.writeFileSync(file, newLines.join('\n'));
  console.log('FIXED:', file);
  fixedCount++;
}

console.log('\nDone! Fixed:', fixedCount, 'Skipped:', skippedCount);
