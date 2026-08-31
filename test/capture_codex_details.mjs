import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function captureDetails() {
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

  await page.evaluateOnNewDocument(() => {
    const registeredTools = new Map();
    window.__mockModelContext = {
      tools: registeredTools,
      registeredToolList: [],
      registerTool(tool) {
        registeredTools.set(tool.name, tool);
        this.registeredToolList.push(tool);
      },
      unregisterTool(name) { registeredTools.delete(name); },
      getTools() { return Array.from(registeredTools.values()); },
      async executeTool(name, args) {
        const tool = registeredTools.get(name);
        if (!tool) throw new Error(`Tool ${name} not found`);
        return await tool.execute(args);
      }
    };
    try {
      Object.defineProperty(navigator, 'modelContext', { value: window.__mockModelContext, writable: true, configurable: true });
      Object.defineProperty(document, 'modelContext', { value: window.__mockModelContext, writable: true, configurable: true });
    } catch (e) {}
  });

  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 7000));

  // Build character / vehicle model
  await page.evaluate(async () => {
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'Chassis', shape: 'box', size: [3.8, 0.6, 1.8], position: [0, 0.6, 0] },
        { name: 'Cabin', shape: 'rounded_box', size: [2.0, 0.9, 1.5], bevel: 0.15, position: [-0.2, 1.35, 0] }
      ]
    });
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'WheelFrontLeft', shape: 'cylinder', radius: 0.45, height: 0.3, position: [1.2, 0.45, 0.95], rotation: [90, 0, 0] },
        { name: 'WheelFrontRight', shape: 'cylinder', radius: 0.45, height: 0.3, position: [1.2, 0.45, -0.95], rotation: [90, 0, 0] },
        { name: 'WheelRearLeft', shape: 'cylinder', radius: 0.45, height: 0.3, position: [-1.2, 0.45, 0.95], rotation: [90, 0, 0] },
        { name: 'WheelRearRight', shape: 'cylinder', radius: 0.45, height: 0.3, position: [-1.2, 0.45, -0.95], rotation: [90, 0, 0] }
      ]
    });
    await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        { name: 'HeadlightLeft', shape: 'sphere', radius: 0.18, position: [1.85, 0.7, 0.55] },
        { name: 'HeadlightRight', shape: 'sphere', radius: 0.18, position: [1.85, 0.7, -0.55] },
        { name: 'FrontGrille', shape: 'box', size: [0.1, 0.35, 0.7], position: [1.88, 0.55, 0] },
        { name: 'RearSpoiler', shape: 'box', size: [0.4, 0.08, 1.7], position: [-1.65, 1.5, 0] }
      ]
    });
  });
  await new Promise(r => setTimeout(r, 2000));

  // Click on the details disclosure summary button
  await page.evaluate(() => {
    const detailsToggle = document.querySelector('details summary, button.scene-details-toggle, [data-action="toggle-scene-details"]') ||
      Array.from(document.querySelectorAll('*')).find(el => el.textContent && el.textContent.includes('Scene details'));
    if (detailsToggle) detailsToggle.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  const shotDetails = path.join(ARTIFACTS_DIR, 'codex_feature1_scene_inspector.png');
  await page.screenshot({ path: shotDetails });
  console.log('Saved:', shotDetails);

  // Click the activity pill at the bottom to expand full activity history
  await page.evaluate(() => {
    const activityPill = document.querySelector('#agent-activity-banner, [data-action="toggle-activity"]') ||
      Array.from(document.querySelectorAll('*')).find(el => el.textContent && el.textContent.includes('Agent attached'));
    if (activityPill) activityPill.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  const shotActivity = path.join(ARTIFACTS_DIR, 'codex_feature2_activity_history.png');
  await page.screenshot({ path: shotActivity });
  console.log('Saved:', shotActivity);

  await browser.close();
}

captureDetails().catch(console.error);
