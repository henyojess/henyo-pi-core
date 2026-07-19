const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'SAMPLE_GLOBAL_AGENTS.md');
const dst = path.join(process.env.HOME || '', '.pi', 'agent', 'AGENTS.md');

try {
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
    console.log(`[henyo-pi-core] installed SAMPLE_GLOBAL_AGENTS.md -> ~/.pi/agent/AGENTS.md`);
  }
} catch (e) {
  // Silently fail - don't break installs if file missing or dir doesn't exist
}
