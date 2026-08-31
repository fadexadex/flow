import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

async function inspectCodexStudio() {
  console.log('--- Launching Chrome to inspect Codex Modeling Studio ---');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--window-size=1440,900'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('console', msg => console.log('  [Studio Console]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('  [Studio PageError]', err.message));

  console.log('--- Navigating to https://codex-modeling-studio.openai.chatgpt.site/ ---');
  try {
    const response = await page.goto('https://codex-modeling-studio.openai.chatgpt.site/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('  Response Status:', response ? response.status() : 'null');
  } catch (e) {
    console.log('  Navigation caught error/timeout:', e.message);
  }

  await new Promise(r => setTimeout(r, 2000));

  // Capture initial screenshot
  const initialShot = path.join(ARTIFACTS_DIR, 'codex_studio_initial.png');
  await page.screenshot({ path: initialShot });
  console.log('  Saved:', initialShot);

  // Inspect page title, DOM structure, window objects, MCP tools
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      htmlLength: document.documentElement.outerHTML.length,
      hasNavigatorModelContext: !!navigator.modelContext,
      hasWindowMcp: !!window.mcp || !!window.webmcp || !!window.godotWebMcpTestBridge,
      windowKeys: Object.keys(window).filter(k => !k.startsWith('webkit') && !k.startsWith('on') && typeof window[k] !== 'function'),
      bodySnippet: document.body ? document.body.innerText.slice(0, 1000) : '',
      buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim() || b.className),
      canvasCount: document.querySelectorAll('canvas').length
    };
  });

  console.log('  Page Info:', JSON.stringify(pageInfo, null, 2));

  await browser.close();
}

inspectCodexStudio().catch(err => {
  console.error('Inspection failed:', err);
  process.exit(1);
});
