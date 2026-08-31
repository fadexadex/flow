import fs from 'fs';

const defs = fs.readFileSync('test/tool-definitions.js', 'utf8');

const matIdx = defs.indexOf('name: "material_sample_apply"');
console.log('=== material_sample_apply ===\n', defs.slice(matIdx - 50, matIdx + 1200));

const sceneGetIdx = defs.indexOf('name: "scene_get"');
console.log('\n=== scene_get ===\n', defs.slice(sceneGetIdx - 50, sceneGetIdx + 1200));
