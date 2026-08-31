import puppeteer from 'puppeteer-core';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function captureStates() {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1200,850']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });

  const htmlPath = 'file://' + path.resolve('test/render_breadcrumb_states.html');
  await page.goto(htmlPath, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));

  const shotPath = path.join(ARTIFACTS_DIR, 'godot_live_entity_breadcrumb_states.png');
  await page.screenshot({ path: shotPath });
  console.log('Saved breadcrumb states screenshot:', shotPath);

  await browser.close();
}

captureStates().catch(console.error);
