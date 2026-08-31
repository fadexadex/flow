import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function analyzeToolsAndVisualFeedback() {
  console.log('--- Analyzing bootstrap.js and Tooling of Codex Modeling Studio ---');
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

  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });

  await new Promise(r => setTimeout(r, 6000));

  // Extract tool definitions and agent interactions from bootstrap.js
  const toolDetails = await page.evaluate(async () => {
    // Check if navigator.modelContext exists or if tools are exposed
    const tools = [];
    
    // Look through window properties or script contents for tool definitions
    const res = await fetch('/bootstrap.js');
    const text = await res.text();

    // Extract tool names / descriptions / schemas matching pattern
    const toolMatches = [...text.matchAll(/name:\s*['"]([a-zA-Z0-9_-]+)['"]/g)].map(m => m[1]);
    
    // Find functions related to agent presence, annotations, transform drafts, camera follow
    return {
      bootstrapLength: text.length,
      toolMatches: [...new Set(toolMatches)],
      hasNavigatorModelContext: !!navigator.modelContext
    };
  });

  console.log('Tool Details from bootstrap.js:', JSON.stringify(toolDetails, null, 2));

  // Let's inspect the exact tools and call them to see the real-time visual collaboration in action!
  const executionTest = await page.evaluate(async () => {
    const runtime = window.__ORIEL_EDITOR_PREVIEW_RUNTIME__;
    if (!runtime) return { error: 'No runtime' };

    // Let's see what happens if we call setAgentInspectionPresence, setAuthoring, setAgentAnnotations, etc.
    const results = {};

    try {
      if (runtime.setAgentInspectionPresence) {
        results.inspection = runtime.setAgentInspectionPresence({
          agent_label: 'AI Modeler',
          action: 'Refining geometry & materials',
          target_entity: 'Cube'
        });
      }
    } catch (e) { results.inspectionError = e.message; }

    return results;
  });

  console.log('Execution Test:', executionTest);
  await new Promise(r => setTimeout(r, 1200));

  const shotInspection = path.join(ARTIFACTS_DIR, 'codex_studio_step4_agent_presence.png');
  await page.screenshot({ path: shotInspection });
  console.log('Saved:', shotInspection);

  await browser.close();
}

analyzeToolsAndVisualFeedback().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
