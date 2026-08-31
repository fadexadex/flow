import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';

async function runResumeUIVerification() {
  console.log('--- Testing Resume Available UI Panel ---');

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--enable-features=SharedArrayBuffer',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto('http://localhost:8060/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#webmcp-diagnostic-hud', { timeout: 10000 });

  // 1. Create a project first so IndexedDB has an authoritative persisted snapshot
  console.log('  Creating project to establish persisted snapshot in this browser profile...');
  await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_create_project', {
      project_name: 'resume_ui_test_project',
      template: 'orbital_garden'
    });
  });

  // 2. Disable auto-resume preference to trigger the manual Resume Panel
  console.log('  Setting godot-webmcp-auto-resume = false...');
  await page.evaluate(() => {
    localStorage.setItem('godot-webmcp-auto-resume', 'false');
  });

  // 3. Reload the page
  console.log('  Reloading page to test resume coordinator...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // Check if resume panel rendered
  const panelInfo = await page.evaluate(() => {
    const panel = document.getElementById('webmcp-resume-panel');
    return {
      hasPanel: Boolean(panel),
      panelText: panel ? panel.innerText : null
    };
  });

  console.log('  Resume Panel Rendered:', panelInfo.hasPanel);
  console.log('  Panel Content:\n' + panelInfo.panelText);

  const panelShot = path.join(ARTIFACTS_DIR, 'step5_resume_panel_ui.png');
  await page.screenshot({ path: panelShot });
  console.log('  Saved Resume Panel screenshot:', panelShot);

  // Click "Open in Safe Mode"
  console.log('  Clicking Safe Mode...');
  await page.evaluate(() => {
    const btnSafe = Array.from(document.querySelectorAll('#webmcp-resume-panel button')).find(b => b.textContent.includes('Safe Mode'));
    if (btnSafe) btnSafe.click();
  });

  await new Promise(r => setTimeout(r, 1200));
  const safeModeShot = path.join(ARTIFACTS_DIR, 'step6_safe_mode_restored.png');
  await page.screenshot({ path: safeModeShot });
  console.log('  Saved Safe Mode screenshot:', safeModeShot);

  // Reset auto-resume preference
  await page.evaluate(() => {
    localStorage.removeItem('godot-webmcp-auto-resume');
  });

  await browser.close();
  console.log('--- Resume UI Verification Complete ---');
}

runResumeUIVerification().catch(err => {
  console.error('Resume UI Verification failed:', err);
  process.exit(1);
});
