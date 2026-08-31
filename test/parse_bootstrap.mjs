import fs from 'fs';

const content = fs.readFileSync('test/codex_bootstrap.js', 'utf8');

const patterns = [
  'tool',
  'mcp',
  'agent',
  'presence',
  'annotation',
  'guided_camera',
  'follow_camera',
  'transform_draft',
  'witness',
  'dense',
  'receipt',
  'inspection',
  'authoring'
];

console.log('--- Search Results in codex_bootstrap.js ---');
for (const p of patterns) {
  const count = (content.match(new RegExp(p, 'gi')) || []).length;
  console.log(`Pattern "${p}": ${count} matches`);
}

// Let's find exported or declared tool schemas and WebMCP definitions
const lines = content.split('\n');
console.log('\n--- Sample Contexts ---');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('agent') || line.includes('mcp') || line.includes('tool') || line.includes('camera')) {
    console.log(`[Line ${i+1}] ${line.slice(0, 140)}`);
  }
}
