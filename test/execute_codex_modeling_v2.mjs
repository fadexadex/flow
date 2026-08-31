import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function modelOnCodexStudio() {
  console.log('--- Launching Chrome with WebMCP Polyfill for Codex Modeling Studio ---');
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
    } catch (e) {
      console.error('[Polyfill WebMCP] Error setting modelContext:', e);
    }
  });

  console.log('--- Navigating to Codex Modeling Studio ---');
  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  console.log('Waiting for engine & WebMCP tool registration...');
  await new Promise(r => setTimeout(r, 7000));

  // Screenshot 1: Connected Studio with WebMCP tools registered
  const shot1 = path.join(ARTIFACTS_DIR, 'codex_step1_connected_agent.png');
  await page.screenshot({ path: shot1 });
  console.log('[Screenshot 1 Saved]:', shot1);

  // -----------------------------------------------------------------------
  // Modeling Step 1: Add a vehicle body and cabin via `parts_add`
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: parts_add (Vehicle Body + Cabin Blockout) ---');
  const addResult = await page.evaluate(async () => {
    return await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        {
          name: 'Chassis',
          shape: 'box',
          size: [3.8, 0.6, 1.8],
          position: [0, 0.6, 0]
        },
        {
          name: 'Cabin',
          shape: 'rounded_box',
          size: [2.0, 0.9, 1.5],
          bevel: 0.15,
          position: [-0.2, 1.35, 0]
        }
      ]
    });
  });
  console.log('  parts_add Result:', JSON.stringify(addResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot2 = path.join(ARTIFACTS_DIR, 'codex_step2_vehicle_body_staged.png');
  await page.screenshot({ path: shot2 });
  console.log('[Screenshot 2 Saved]:', shot2);

  // -----------------------------------------------------------------------
  // Modeling Step 2: Add 4 Wheels and Headlights via `parts_add`
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: parts_add (4 Wheels & Dual Headlights) ---');
  const wheelsResult = await page.evaluate(async () => {
    return await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        {
          name: 'WheelFrontLeft',
          shape: 'cylinder',
          radius: 0.45,
          height: 0.3,
          position: [1.2, 0.45, 0.95],
          rotation: [90, 0, 0]
        },
        {
          name: 'WheelFrontRight',
          shape: 'cylinder',
          radius: 0.45,
          height: 0.3,
          position: [1.2, 0.45, -0.95],
          rotation: [90, 0, 0]
        },
        {
          name: 'WheelRearLeft',
          shape: 'cylinder',
          radius: 0.45,
          height: 0.3,
          position: [-1.2, 0.45, 0.95],
          rotation: [90, 0, 0]
        },
        {
          name: 'WheelRearRight',
          shape: 'cylinder',
          radius: 0.45,
          height: 0.3,
          position: [-1.2, 0.45, -0.95],
          rotation: [90, 0, 0]
        }
      ]
    });
  });
  console.log('  wheels Result:', JSON.stringify(wheelsResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot3 = path.join(ARTIFACTS_DIR, 'codex_step3_wheels_assembled.png');
  await page.screenshot({ path: shot3 });
  console.log('[Screenshot 3 Saved]:', shot3);

  // -----------------------------------------------------------------------
  // Modeling Step 3: Scene Preflight Batch & Environment Light Adjust
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: environment_set (Adjust Sun & Lighting) ---');
  const envResult = await page.evaluate(async () => {
    if (window.__mockModelContext.tools.has('environment_set')) {
      return await window.__mockModelContext.executeTool('environment_set', {
        sun_direction: [0.6, 0.8, 0.3],
        ambient_intensity: 0.4
      });
    }
    return { skipped: true };
  });
  console.log('  environment_set Result:', JSON.stringify(envResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot4 = path.join(ARTIFACTS_DIR, 'codex_step4_environment_tuned.png');
  await page.screenshot({ path: shot4 });
  console.log('[Screenshot 4 Saved]:', shot4);

  // -----------------------------------------------------------------------
  // Modeling Step 4: Expand Scene Details Panel to show live scene tree
  // -----------------------------------------------------------------------
  console.log('\n--- Expanding Scene details Panel ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sceneDetailsBtn = btns.find(b => b.innerText.includes('Scene details'));
    if (sceneDetailsBtn) sceneDetailsBtn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  const shot5 = path.join(ARTIFACTS_DIR, 'codex_step5_scene_hierarchy_panel.png');
  await page.screenshot({ path: shot5 });
  console.log('[Screenshot 5 Saved]:', shot5);

  await browser.close();
  console.log('\n=== Codex Modeling Studio Experiment Completed ===');
}

modelOnCodexStudio().catch(err => {
  console.error('Modeling failed:', err);
  process.exit(1);
});
