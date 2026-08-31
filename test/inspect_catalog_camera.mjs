import fs from 'fs';

const catalog = fs.readFileSync('test/studio-public-tool-catalog.js', 'utf8');
const camera = fs.readFileSync('test/camera-guidance.js', 'utf8');

console.log('=== Public Tool Catalog (First 100 lines) ===');
console.log(catalog.slice(0, 3000));

console.log('\n=== Camera Guidance (First 100 lines) ===');
console.log(camera.slice(0, 3000));
