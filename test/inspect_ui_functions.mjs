import fs from 'fs';

const ui = fs.readFileSync('test/studio-ui.js', 'utf8');

const lines = ui.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function ') || lines[i].includes('export ') || lines[i].includes('createStudioUI')) {
    console.log(`[L${i+1}] ${lines[i].slice(0, 120)}`);
  }
}
