import fs from 'fs';

const camera = fs.readFileSync('test/camera-guidance.js', 'utf8');
const toolDefs = fs.readFileSync('test/tool-definitions.js', 'utf8');

console.log('=== Camera Guidance functions ===');
const lines = camera.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function ') || lines[i].includes('export ') || lines[i].includes('class ')) {
    console.log(`[L${i+1}] ${lines[i].slice(0, 120)}`);
  }
}

console.log('\n=== Tool Definitions summary ===');
const toolLines = toolDefs.split('\n');
const declaredTools = [];
for (let i = 0; i < toolLines.length; i++) {
  if (toolLines[i].includes('name:') && toolLines[i-1]?.includes('{')) {
    declaredTools.push(toolLines[i].trim());
  }
}
console.log('Declared Tools:', declaredTools.slice(0, 30));
