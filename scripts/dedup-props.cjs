const fs = require('fs');

function deduplicateProperties(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  const origLen = css.length;
  const lines = css.split('\n');
  const output = [];
  let i = 0;
  let deduped = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    // Find rule blocks
    if (t.includes('{') && !t.startsWith('@keyframes') && !t.startsWith('@media') && !t.startsWith('@supports') && !t.startsWith('/*')) {
      // Collect lines until closing }
      const ruleStart = i;
      let depth = 0;
      let ruleEnd = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        ruleEnd = j;
        if (depth <= 0) break;
      }

      // Only process simple rules (depth never > 1)
      let maxDepth = 0;
      let d = 0;
      for (let j = ruleStart; j <= ruleEnd; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') d++;
          if (ch === '}') d--;
          if (d > maxDepth) maxDepth = d;
        }
      }

      if (maxDepth === 1) {
        // Extract properties
        const selectorLine = lines[ruleStart];
        output.push(selectorLine);

        const props = new Map(); // property -> last value line
        const propOrder = []; // maintain order

        for (let j = ruleStart + 1; j < ruleEnd; j++) {
          const propLine = lines[j].trim();
          if (!propLine || propLine === '}') continue;

          // Extract property name
          const colonIdx = propLine.indexOf(':');
          if (colonIdx > 0) {
            const propName = propLine.substring(0, colonIdx).trim();
            if (props.has(propName)) {
              deduped++;
              // Remove old position
              const oldIdx = propOrder.indexOf(propName);
              if (oldIdx >= 0) propOrder.splice(oldIdx, 1);
            }
            props.set(propName, lines[j]);
            propOrder.push(propName);
          } else {
            // Non-property line (like comment)
            output.push(lines[j]);
          }
        }

        // Write properties in order
        for (const pn of propOrder) {
          output.push(props.get(pn));
        }

        output.push(lines[ruleEnd]);
        i = ruleEnd + 1;
      } else {
        // Complex rule (nested), pass through unchanged
        for (let j = ruleStart; j <= ruleEnd; j++) {
          output.push(lines[j]);
        }
        i = ruleEnd + 1;
      }
    } else {
      output.push(lines[i]);
      i++;
    }
  }

  let result = output.join('\n');

  // Brace check
  let depth = 0;
  for (const ch of result) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { console.log(filePath + ': ERROR braces!'); return; }
  }
  if (depth !== 0) { console.log(filePath + ': ERROR ' + depth + ' unclosed!'); return; }

  console.log(filePath + ': ' + origLen + ' -> ' + result.length + ' (-' + (origLen - result.length) + '), ' + deduped + ' duplicate properties removed');
  fs.writeFileSync(filePath, result);
}

deduplicateProperties('src/styles/dj-lobby.css');
deduplicateProperties('src/styles/live.css');
