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
    const toolCallListeners = [];

    window.__mockModelContext = {
      tools: registeredTools,
      registeredToolList: [],
      registerTool(tool) {
        registeredTools.set(tool.name, tool);
        this.registeredToolList.push(tool);
        console.log('[Polyfill WebMCP] Registered tool:', tool.name);
      },
      unregisterTool(name) {
        registeredTools.delete(name);
      },
      getTools() {
        return Array.from(registeredTools.values());
      },
      async executeTool(name, args) {
        console.log('[Polyfill WebMCP] Invoking tool:', name, JSON.stringify(args));
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

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('WebMCP') || txt.includes('tool') || txt.includes('Agent') || txt.includes('guidance')) {
      console.log('  [Console]', txt);
    }
  });

  console.log('--- Navigating to Codex Modeling Studio ---');
  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  console.log('Waiting for engine & WebMCP tool registration...');
  await new Promise(r => setTimeout(r, 7000));

  // Check registered tools
  const tools = await page.evaluate(() => {
    return window.__mockModelContext?.registeredToolList?.map(t => ({
      name: t.name,
      description: t.description?.slice(0, 80),
      hasSchema: !!t.inputSchema
    })) || [];
  });

  console.log(`\nRegistered ${tools.length} Tools on WebMCP surface:`);
  tools.forEach(t => console.log(`  • ${t.name.padEnd(25)}: ${t.description}`));

  // Screenshot 1: Connected Studio with WebMCP tools registered
  const shot1 = path.join(ARTIFACTS_DIR, 'codex_step1_connected_agent.png');
  await page.screenshot({ path: shot1 });
  console.log('\n[Screenshot 1 Saved]:', shot1);

  // -----------------------------------------------------------------------
  // Modeling Step 1: Add a character body & head via `parts_add`
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: parts_add (Character Base: Torso & Head) ---');
  const addResult = await page.evaluate(async () => {
    return await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        {
          name: 'Torso',
          primitive: { kind: 'cylinder', radius: 0.8, height: 1.6 },
          transform: { translation: [0, 1.2, 0] },
          material: { color: [0.15, 0.45, 0.85, 1.0], metallic: 0.2, roughness: 0.3 }
        },
        {
          name: 'Head',
          primitive: { kind: 'sphere', radius: 0.65 },
          transform: { translation: [0, 2.5, 0] },
          material: { color: [0.95, 0.75, 0.65, 1.0], roughness: 0.6 }
        }
      ]
    });
  });
  console.log('  parts_add Result:', JSON.stringify(addResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot2 = path.join(ARTIFACTS_DIR, 'codex_step2_parts_added.png');
  await page.screenshot({ path: shot2 });
  console.log('[Screenshot 2 Saved]:', shot2);

  // -----------------------------------------------------------------------
  // Modeling Step 2: Camera Guide & Framing onto Head
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: camera_guide (Focusing on Head) ---');
  const guideResult = await page.evaluate(async () => {
    if (window.__mockModelContext.tools.has('camera_guide')) {
      return await window.__mockModelContext.executeTool('camera_guide', {
        target: 'Head',
        framing: { distance: 3.5, elevation_angle: 15, azimuth_angle: 35 }
      });
    } else if (window.__mockModelContext.tools.has('focus_target')) {
      return await window.__mockModelContext.executeTool('focus_target', {
        target: 'Head'
      });
    }
    return { skipped: true };
  });
  console.log('  camera_guide Result:', JSON.stringify(guideResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot3 = path.join(ARTIFACTS_DIR, 'codex_step3_camera_guided.png');
  await page.screenshot({ path: shot3 });
  console.log('[Screenshot 3 Saved]:', shot3);

  // -----------------------------------------------------------------------
  // Modeling Step 3: Add Details (Limbs & Glowing Visor)
  // -----------------------------------------------------------------------
  console.log('\n--- Executing Tool: parts_add (Limbs & Glowing Visor) ---');
  const detailsResult = await page.evaluate(async () => {
    return await window.__mockModelContext.executeTool('parts_add', {
      parts: [
        {
          name: 'Visor',
          primitive: { kind: 'box', size: [0.7, 0.25, 0.35] },
          transform: { translation: [0, 2.55, 0.45] },
          material: { color: [0.0, 1.0, 0.8, 1.0], emission: [0.0, 1.0, 0.8, 1.0], roughness: 0.1 }
        },
        {
          name: 'LeftArm',
          primitive: { kind: 'cylinder', radius: 0.22, height: 1.2 },
          transform: { translation: [-1.15, 1.2, 0], rotation: [0, 0, 0.2] },
          material: { color: [0.15, 0.45, 0.85, 1.0] }
        },
        {
          name: 'RightArm',
          primitive: { kind: 'cylinder', radius: 0.22, height: 1.2 },
          transform: { translation: [1.15, 1.2, 0], rotation: [0, 0, -0.2] },
          material: { color: [0.15, 0.45, 0.85, 1.0] }
        }
      ]
    });
  });
  console.log('  details Result:', JSON.stringify(detailsResult, null, 2));
  await new Promise(r => setTimeout(r, 2000));

  const shot4 = path.join(ARTIFACTS_DIR, 'codex_step4_character_detailed.png');
  await page.screenshot({ path: shot4 });
  console.log('[Screenshot 4 Saved]:', shot4);

  // -----------------------------------------------------------------------
  // Modeling Step 4: Expand Scene Details Panel to show Hierarchy & Inspector
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
}

modelOnCodexStudio().catch(err => {
  console.error('Modeling failed:', err);
  process.exit(1);
});
