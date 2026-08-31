import fs from 'fs';

const content = fs.readFileSync('test/codex_bootstrap.js', 'utf8');

const startIdx = content.indexOf('function installPageToolBridge');
console.log(content.slice(startIdx, startIdx + 3500));
