import fs from 'fs';

const defs = fs.readFileSync('test/tool-definitions.js', 'utf8');

const pAddIdx = defs.indexOf('name: "part_add"');
console.log('=== part_add ===\n', defs.slice(pAddIdx - 50, pAddIdx + 1200));

const psAddIdx = defs.indexOf('name: "parts_add"');
console.log('\n=== parts_add ===\n', defs.slice(psAddIdx - 50, psAddIdx + 1200));
