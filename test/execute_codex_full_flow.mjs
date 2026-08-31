import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function fullFlow() {
  console.log('--- Launching Full Codex Modeling Studio Collaboration Flow ---');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--enable-unsafe-webgpu',
      '--window-size=1440,900'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Pre-inject navigator.modelContext
  await page.evaluateOnNewDocument(() => {
    const registeredTools = new Map();
    window.__mockModelContext = {
      tools: registeredTools,
      registeredToolList: [],
      registerTool(tool) {
        registeredTools.set(tool.name, tool);
        this.registeredToolList.push(tool);
      },
      unregisterTool(name) {
        registeredTools.delete(name);
      },
      getTools() {
        return Array.from(registeredTools.values());
      },
      async executeTool(name, args) {
        const tool = registeredTools.get(name);
        if (!tool) throw new Error(`Tool ${name} not found`);
        return await tool.execute(args);
      }
    };

    try {
      Object.defineProperty(navigator, 'modelContext', {
        value: window.__mockModelContext,
        writable: true,
        configurable: true
      });
      Object.defineProperty(document, 'modelContext', {
        value: window.__mockModelContext,
        writable: true,
        configurable: true
      });
    } catch (e) {}
  });

  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  console.log('Waiting for engine & WebMCP tool registration...');
  await new Promise(r => setTimeout(r, 7000));

  // Step 1: Initial state
  const shot1 = path.join(ARTIFACTS_DIR, 'codex_flow_1_ready.png');
  await page.screenshot({ path: shot1 });
  console.log('Saved:', shot1);

  // Step 2: Add Chassis + Cabin
  console.log('--- Step 2: Adding Chassis & Cabin ---');
  await page.evaluate(async () => {
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'Chassis', shape: 'box', size: [3.8, 0.6, 1.8], position: [0, 0.6, 0] },
        { name: 'Cabin', shape: 'rounded_box', size: [2.0, 0.9, 1.5], bevel: 0.15, position: [-0.2, 1.35, 0] }
      ]
    });
  });
  await new Promise(r => setTimeout(r, 1500));
  const shot2 = path.join(ARTIFACTS_DIR, 'codex_flow_2_chassis_cabin.png');
  await page.screenshot({ path: shot2 });
  console.log('Saved:', shot2);

  // Step 3: Add Wheels
  console.log('--- Step 3: Adding 4 Wheels ---');
  await page.evaluate(async () => {
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'WheelFrontLeft', shape: 'cylinder', radius: 0.45, height: 0.3, position: [1.2, 0.45, 0.95], rotation: [90, 0, 0] },
        { name: 'WheelFrontRight', shape: 'cylinder', radius: 0.45, height: 0.3, position: [1.2, 0.45, -0.95], rotation: [90, 0, 0] },
        { name: 'WheelRearLeft', shape: 'cylinder', radius: 0.45, height: 0.3, position: [-1.2, 0.45, 0.95], rotation: [90, 0, 0] },
        { name: 'WheelRearRight', shape: 'cylinder', radius: 0.45, height: 0.3, position: [-1.2, 0.45, -0.95], rotation: [90, 0, 0] }
      ]
    });
  });
  await new Promise(r => setTimeout(r, 1500));
  const shot3 = path.join(ARTIFACTS_DIR, 'codex_flow_3_wheels.png');
  await page.screenshot({ path: shot3 });
  console.log('Saved:', shot3);

  // Step 4: Add Headlights & Grille & Rear Wing
  console.log('--- Step 4: Adding Headlights, Grille & Spoiler ---');
  await page.evaluate(async () => {
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'HeadlightLeft', shape: 'sphere', radius: 0.18, position: [1.85, 0.7, 0.55] },
        { name: 'HeadlightRight', shape: 'sphere', radius: 0.18, position: [1.85, 0.7, -0.55] },
        { name: 'FrontGrille', shape: 'box', size: [0.1, 0.35, 0.7], position: [1.88, 0.55, 0] },
        { name: 'RearSpoiler', shape: 'box', size: [0.4, 0.08, 1.7], position: [-1.65, 1.5, 0] }
      ]
    });
  });
  await new Promise(r => setTimeout(r, 1500));
  const shot4 = path.join(ARTIFACTS_DIR, 'codex_flow_4_accessories.png');
  await page.screenshot({ path: shot4 });
  console.log('Saved:', shot4);

  // Step 5: Expand Scene Details panel
  console.log('--- Step 5: Expanding Scene Details Panel ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sceneDetailsBtn = btns.find(b => b.innerText.includes('Scene details'));
    if (sceneDetailsBtn) sceneDetailsBtn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  const shot5 = path.join(ARTIFACTS_DIR, 'codex_flow_5_scene_tree_open.png');
  await page.screenshot({ path: shot5 });
  console.log('Saved:', shot5);

  // Step 6: Click on FrontGrille entity in the UI
  console.log('--- Step 6: Selecting an Entity in Hierarchy ---');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('*')).filter(el => el.innerText && el.innerText.trim() === 'FrontGrille');
    if (items.length > 0) {
      items[0].click();
    }
  });
  await new Promise(r => setTimeout(r, 1500));

  const shot6 = path.join(ARTIFACTS_DIR, 'codex_flow_6_entity_selected.png');
  await page.screenshot({ path: shot6 });
  console.log('Saved:', shot6);

  await browser.close();
  console.log('\n=== Full Flow Complete ===');
}

fullFlow().catch(err => {
  console.error('Flow failed:', err);
  process.exit(1);
});
