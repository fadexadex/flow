import fs from 'fs';

const content = fs.readFileSync('test/codex_bootstrap.js', 'utf8');

// Search for createStudioTools call in codex_bootstrap.js
const idx = content.indexOf('createStudioTools');
console.log(content.slice(idx - 200, idx + 1500));
