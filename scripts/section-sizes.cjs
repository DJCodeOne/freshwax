const fs = require('fs');

function analyzeSections(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const lines = css.split('\n');

  // Find sections by comment headers
  const sections = [];
  let currentSection = { name: 'TOP', start: 0 };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Match section headers (comments with === or --- or significant length)
    if (t.startsWith('/*') && t.endsWith('*/') && (t.includes('===') || t.includes('---') || t.length > 40)) {
      if (currentSection) {
        currentSection.end = i - 1;
        currentSection.size = currentSection.end - currentSection.start + 1;
        sections.push(currentSection);
      }
      currentSection = { name: t.substring(2, t.length - 2).trim(), start: i };
    }
    // Also match multi-line comments that start sections
    if (t.startsWith('/*') && t.includes('===') && !t.endsWith('*/')) {
      // Find end of comment
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      const fullComment = lines.slice(i, j + 1).join(' ').replace(/\/\*|\*\//g, '').trim();
      if (currentSection) {
        currentSection.end = i - 1;
        currentSection.size = currentSection.end - currentSection.start + 1;
        sections.push(currentSection);
      }
      currentSection = { name: fullComment.substring(0, 60), start: i };
      i = j;
    }
  }

  if (currentSection) {
    currentSection.end = lines.length - 1;
    currentSection.size = currentSection.end - currentSection.start + 1;
    sections.push(currentSection);
  }

  // Sort by size descending
  sections.sort((a, b) => b.size - a.size);

  console.log('\n' + filePath + ' - Top sections by size:');
  let totalLines = 0;
  sections.forEach(s => {
    if (s.size > 30) {
      const bytes = lines.slice(s.start, s.end + 1).join('\n').length;
      console.log(`  L${s.start + 1}-${s.end + 1} (${s.size} lines, ${bytes}B): ${s.name.substring(0, 70)}`);
      totalLines += s.size;
    }
  });
  console.log('  Total accounted: ' + totalLines + ' / ' + lines.length + ' lines');
}

analyzeSections('src/styles/dj-lobby.css');
analyzeSections('src/styles/live.css');
