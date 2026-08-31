import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function deepDive() {
  console.log('--- Launching Chrome for Deep Dive into Codex Modeling Studio ---');
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

  page.on('console', msg => console.log('  [Console]', msg.text()));

  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  // Wait for Bevy / WebGPU engine and UI to finish initializing
  console.log('Waiting for engine workspace initialization...');
  await new Promise(r => setTimeout(r, 6000));

  // Screenshot 1: Loaded Workspace
  const shot1 = path.join(ARTIFACTS_DIR, 'codex_studio_step1_workspace_loaded.png');
  await page.screenshot({ path: shot1 });
  console.log('Saved:', shot1);

  // Inspect the runtime internals and available MCP tools / APIs
  const runtimeInspection = await page.evaluate(() => {
    const runtime = window.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    const diag = window.__ORIEL_RUNTIME_DIAGNOSTICS__;

    const runtimeKeys = runtime ? Object.keys(runtime) : [];
    const runtimeProtoKeys = runtime ? Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)) : [];
    const diagKeys = diag ? Object.keys(diag) : [];

    // Check for any window MCP or registered tools
    let mcpTools = [];
    if (window.webmcp && window.webmcp.getTools) {
      mcpTools = window.webmcp.getTools();
    } else if (window.mcp && window.mcp.tools) {
      mcpTools = window.mcp.tools;
    }

    return {
      runtimeKeys,
      runtimeProtoKeys,
      diagKeys,
      runtimeType: typeof runtime,
      diagContent: diag,
      mcpTools
    };
  });

  console.log('Runtime Inspection:', JSON.stringify(runtimeInspection, null, 2));

  // Let's inspect the entire DOM scripts and inspect what functions are available
  const scriptAnalysis = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script')).map(s => ({
      src: s.src,
      inline: s.innerHTML.slice(0, 300)
    }));
    return scripts;
  });

  console.log('Scripts:', JSON.stringify(scriptAnalysis, null, 2));

  // Let's click on "Scene details" button to expand the scene inspector panel
  console.log('--- Clicking Scene details ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sceneDetailsBtn = btns.find(b => b.innerText.includes('Scene details'));
    if (sceneDetailsBtn) sceneDetailsBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  const shot2 = path.join(ARTIFACTS_DIR, 'codex_studio_step2_scene_details.png');
  await page.screenshot({ path: shot2 });
  console.log('Saved:', shot2);

  // Let's click on "Projects" button to see the projects management drawer
  console.log('--- Clicking Projects ---');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const projectsBtn = btns.find(b => b.innerText.includes('Projects'));
    if (projectsBtn) projectsBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  const shot3 = path.join(ARTIFACTS_DIR, 'codex_studio_step3_projects_drawer.png');
  await page.screenshot({ path: shot3 });
  console.log('Saved:', shot3);

  // Let's inspect what happens during model manipulation / agent tools
  // Let's see if there are tools exposed via WebSocket or HTTP or in-page functions
  const bridgeAnalysis = await page.evaluate(() => {
    // Search window for any tool arrays or schemas
    const found = {};
    for (const k in window) {
      if (k.includes('oriel') || k.includes('mcp') || k.includes('tool') || k.includes('model') || k.includes('bevy')) {
        try {
          found[k] = typeof window[k];
        } catch (_) {}
      }
    }
    return found;
  });
  console.log('Bridge & Global Matching Keys:', bridgeAnalysis);

  await browser.close();
}

deepDive().catch(err => {
  console.error('Deep dive failed:', err);
  process.exit(1);
});
