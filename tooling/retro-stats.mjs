#!/usr/bin/env node
// retro-stats — execution stats for a plan retrospective (the standard
// stats set; see the project process note's Retrospective section).
//
// Usage:
//   node tooling/retro-stats.mjs <session.jsonl> [<session.jsonl> ...]
//       [--repo <path> --baseline <sha>] [--since <ISO>] [--until <ISO>]
//       [--idle-min <n>]
//
// Session jsonl files span phases (execution + later retro/Q&A turns);
// --since/--until slice each file to a window before counting.
//
// Per session file (window-filtered):
//   span          first -> last event timestamp
//   active min    consecutive event gaps <= --idle-min (default 10) summed;
//                 longer idle gaps excluded
//   compactions   count + max tokensBefore
//   peak context  max usage.totalTokens over assistant messages
//   tool calls    assistant toolCall blocks
//   owner msgs    user-role messages (count; the first is usually the
//                 session directive, not an interruption)
// With --repo + --baseline: commit count for baseline..HEAD in that repo.
//
// Output: plain text, one block per session + a repo line when given.
// Exit 0 on success, 1 on usage/read error. No dependencies, no pi imports.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const sessions = [];
let repo = null;
let baseline = null;
let since = null;
let until = null;
let idleMin = 10;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--repo') repo = args[++i];
  else if (a === '--baseline') baseline = args[++i];
  else if (a === '--since') since = args[++i];
  else if (a === '--until') until = args[++i];
  else if (a === '--idle-min') idleMin = Number(args[++i]);
  else sessions.push(a);
}
if (sessions.length === 0) {
  console.error(
    'usage: node retro-stats.mjs <session.jsonl> [...] [--repo <path> --baseline <sha>] [--since <ISO>] [--until <ISO>] [--idle-min <n>]',
  );
  process.exit(1);
}

const inWindow = (ts) => {
  if (!ts || typeof ts !== 'string') return true;
  if (since && ts < since) return false;
  if (until && ts > until) return false;
  return true;
};

for (const file of sessions) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`error: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
  const times = [];
  let compactions = 0;
  let maxTokensBefore = 0;
  let peak = 0;
  let toolCalls = 0;
  let ownerMsgs = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!inWindow(o.timestamp)) continue;
    if (typeof o.timestamp === 'string') times.push(new Date(o.timestamp).getTime());
    if (o.type === 'compaction') {
      compactions++;
      maxTokensBefore = Math.max(maxTokensBefore, Number(o.tokensBefore) || 0);
    } else if (o.type === 'message') {
      const m = o.message || {};
      if (m.usage) peak = Math.max(peak, m.usage.totalTokens || 0);
      if (m.role === 'user') ownerMsgs++;
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'toolCall') toolCalls++;
      }
    }
  }
  times.sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap <= idleMin * 60000) activeMs += gap;
  }
  const iso = (t) => (t ? new Date(t).toISOString() : '-');
  console.log(`session: ${file}`);
  console.log(`  span:         ${iso(times[0])} -> ${iso(times[times.length - 1])}`);
  console.log(
    `  active:       ${(activeMs / 60000).toFixed(1)} min (gaps > ${idleMin} min excluded)`,
  );
  console.log(
    `  compactions:  ${compactions}${maxTokensBefore ? ` (max tokensBefore ${maxTokensBefore})` : ''}`,
  );
  console.log(`  peak context: ${peak} tokens (max usage.totalTokens)`);
  console.log(`  tool calls:   ${toolCalls}`);
  console.log(`  owner msgs:   ${ownerMsgs}`);
}

if (repo && baseline) {
  const count = execFileSync('git', ['-C', repo, 'rev-list', '--count', `${baseline}..HEAD`], {
    encoding: 'utf8',
  }).trim();
  console.log(`repo: ${repo} - ${count} commits ${baseline}..HEAD`);
}
