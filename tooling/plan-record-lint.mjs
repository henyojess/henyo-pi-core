#!/usr/bin/env node
// P4: plan-record-lint — line-level linter for plan-execution records.
//
// Usage: node tooling/plan-record-lint.mjs <plan.md>
//
// Checks (one assertion per line, except R2 which is per ticked action):
//   R1  no physical line holds two checkboxes (`- [ ]` / `- [x]`)
//   R2  every [x] action line (`- [x] N.k ...`) has at least one indented
//       note line below it, before the next checkbox line
//   R3  no note under a ticked action contains pending|TODO|will |planned|to be
//       (case-insensitive — P8's violation marker)
//   R4  every commit action's note (`N.k Commit`, except `Commit: none`
//       baseline lines) contains a 7-character commit hash
//
// Output: one line per violation (line number, rule id, snippet);
// exit 0 when clean, 1 otherwise. No dependencies, no pi imports.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node plan-record-lint.mjs <plan.md>');
  process.exit(1);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`error: cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const lines = text.split('\n');
const violations = [];

// checkbox occurrences on a line, with their in-line indices
function checkboxOffsets(line) {
  const offsets = [];
  const re = /- \[([ x])\]/g;
  let m;
  while ((m = re.exec(line)) !== null) offsets.push(m.index);
  return offsets;
}

function snippet(line) {
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

// Is this line a checkbox bullet (or part of one)?
function isCheckboxLine(line) {
  return checkboxOffsets(line).length > 0;
}

// Collect the note lines that follow a ticked action's checkbox line:
// indented, non-checkbox lines up to the next checkbox line / blank-then-
// checkbox boundary. Blank lines inside the note block are skipped; the
// block ends at the next checkbox line or the next top-level heading.
function noteLinesAfter(startIdx) {
  const notes = [];
  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (isCheckboxLine(line) || /^#{1,6}\s/.test(line)) break;
    if (line.trim() === '') {
      // a blank line ends the note block unless the next line is indented
      // note text continuing the same block
      const next = lines[i + 1];
      if (next === undefined || !/^\s+\S/.test(next) || isCheckboxLine(next)) break;
      i += 1;
      continue;
    }
    if (/^\s+\S/.test(line)) {
      notes.push({ idx: i, line });
      i += 1;
      continue;
    }
    break;
  }
  return notes;
}

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const ln = i + 1;
  const boxes = checkboxOffsets(line);

  // R1: no physical line holds two checkboxes
  if (boxes.length > 1) {
    violations.push({ ln, rule: 'R1', snippet: snippet(line) });
  }

  // single checkbox line that is a ticked action bullet
  if (boxes.length === 1) {
    const m = line.match(/^(\s*)- \[([ x])\] (\d)\.(\d+) (.*)$/);
    const isTickedAction = Boolean(m && m[2] === 'x');
    if (isTickedAction) {
      const notes = noteLinesAfter(i);

      // R2: every [x] action line has at least one indented note line
      // below it, before the next checkbox
      if (notes.length === 0) {
        violations.push({ ln, rule: 'R2', snippet: snippet(line) });
      }

      // R3: no pending/TODO/will /planned/to be marker in a ticked action's note
      for (const note of notes) {
        if (/(pending|todo|will |planned|to be)/i.test(note.line)) {
          violations.push({
            ln: note.idx + 1,
            rule: 'R3',
            snippet: snippet(line) + ' -> note: ' + snippet(note.line),
          });
        }
      }

      // R4: commit actions' notes carry a 7-char hash, unless "Commit: none"
      const actionText = m ? m[5] : '';
      if (/\bCommit\b/i.test(actionText) && !/Commit:\s*none\b/i.test(actionText)) {
        const hasHash = notes.some((n) => /\b[0-9a-f]{7}\b/.test(n.line));
        if (!hasHash) {
          violations.push({ ln, rule: 'R4', snippet: snippet(line) });
        }
      }
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.log(`${file}:${v.ln}: [${v.rule}] ${v.snippet}`);
  }
  console.log(`\n${violations.length} violation(s)`);
  process.exit(1);
}

console.log('clean');
process.exit(0);
