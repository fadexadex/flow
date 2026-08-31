import fs from 'fs';

const defs = fs.readFileSync('test/tool-definitions.js', 'utf8');

const pFieldsIdx = defs.indexOf('partFields =');
console.log('=== partFields ===\n', defs.slice(pFieldsIdx - 50, pFieldsIdx + 1500));
