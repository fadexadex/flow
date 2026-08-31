import fs from 'fs';

const content = fs.readFileSync('test/codex_bootstrap.js', 'utf8');

const matches = [];
let pos = 0;
while ((pos = content.indexOf('Scene details', pos)) !== -1) {
  matches.push(content.slice(Math.max(0, pos - 150), pos + 300));
  pos += 'Scene details'.length;
}

console.log('Matches for "Scene details":', matches);
