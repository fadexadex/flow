import fs from 'fs';

const ui = fs.readFileSync('test/studio-ui.js', 'utf8');

const terms = [
  'agent',
  'banner',
  'pill',
  'scene details',
  'scene-details',
  'camera',
  'auto follow',
  'breadcrumb',
  'inspector',
  'presence',
  'status'
];

for (const t of terms) {
  const count = (ui.match(new RegExp(t, 'gi')) || []).length;
  console.log(`Term "${t}": ${count} occurrences`);
}

// Extract the scene details toggle and drawer
const drawerIdx = ui.indexOf('scene details') !== -1 ? ui.indexOf('scene details') : ui.indexOf('Scene details');
console.log('\n=== Scene Details section in UI ===');
console.log(ui.slice(drawerIdx - 200, drawerIdx + 1200));
