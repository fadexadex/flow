import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = '/Users/fadex/.gemini/antigravity/brain/b6740f2c-938d-470b-8bc4-b2fbf28438b0';
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

async function runVerification() {
  console.log('--- Launching Browser Verification ---');

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

  // Listen to browser console logs
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[WebMCP') || text.includes('[Agent') || text.includes('Diagnostic')) {
      console.log('  [Browser Console]', text);
    }
  });

  console.log('1. Navigating to http://localhost:8060...');
  await page.goto('http://localhost:8060/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#webmcp-diagnostic-hud', { timeout: 10000 });

  // Wait a moment for DOM and bridge hydration
  await new Promise(r => setTimeout(r, 1000));

  const initialShot = path.join(ARTIFACTS_DIR, 'step1_initial_load.png');
  await page.screenshot({ path: initialShot });
  console.log('  Saved screenshot:', initialShot);

  // Check initial session status
  const sessionStatus = await page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_get_session_status', {});
  });
  console.log('  Initial Session Status:', JSON.stringify(sessionStatus.persistence, null, 2));

  // 2. Trigger project creation and observe step-by-step visual representation
  console.log('\n2. Calling godot_create_project to verify phase progression and visual HUD...');
  
  // Track observation events
  await page.evaluate(() => {
    window.__observedEvents = [];
    window.addEventListener('godot:webmcp-observation', (e) => {
      window.__observedEvents.push(e.detail);
    });
  });

  // Start creation asynchronously
  const createPromise = page.evaluate(async () => {
    return await window.godotWebMcpTestBridge.callTool('godot_create_project', {
      project_name: 'botanical_sanctuary_test',
      template: 'orbital_garden'
    });
  });

  // Sample the visual feed and banner during execution
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 600));
    const hudState = await page.evaluate(() => {
      const banner = document.getElementById('webmcp-agent-action-banner');
      const feed = document.getElementById('webmcp-agent-action-feed');
      return {
        bannerText: banner ? banner.textContent : null,
        bannerOpacity: banner ? banner.style.opacity : null,
        feedHTML: feed ? feed.innerText : null,
        eventsCount: window.__observedEvents ? window.__observedEvents.length : 0,
        latestEvent: window.__observedEvents && window.__observedEvents.length > 0
          ? window.__observedEvents[window.__observedEvents.length - 1]
          : null
      };
    });
    console.log(`  Phase sample [${i+1}]: Banner="${hudState.bannerText}", LatestEvent="${hudState.latestEvent?.phase || hudState.latestEvent?.status}"`);
    
    if (i === 1) {
      const activeShot = path.join(ARTIFACTS_DIR, 'step2_active_phase.png');
      await page.screenshot({ path: activeShot });
      console.log('  Saved active phase screenshot:', activeShot);
    }
  }

  // Await creation completion
  const createResult = await createPromise;
  console.log('  Project creation returned:', JSON.stringify(createResult, null, 2));

  const completeShot = path.join(ARTIFACTS_DIR, 'step3_project_created.png');
  await page.screenshot({ path: completeShot });
  console.log('  Saved project created screenshot:', completeShot);

  // 3. Verify operation status change-aware wait and deduplication
  console.log('\n3. Testing change-aware godot_get_operation_status polling...');
  const inspectTest = await page.evaluate(async () => {
    const start = performance.now();
    const statusResult = await window.godotWebMcpTestBridge.callTool('godot_get_operation_status', {
      wait_ms: 1000
    });
    const duration = performance.now() - start;
    const feed = document.getElementById('webmcp-agent-action-feed');
    return {
      duration_ms: duration,
      statusResult,
      feedText: feed ? feed.innerText : ''
    };
  });
  console.log('  get_operation_status returned in:', inspectTest.duration_ms.toFixed(1), 'ms');
  console.log('  Feed content (no inspection flood):', inspectTest.feedText);

  // 4. Test page reload and safe auto-restore
  console.log('\n4. Testing page reload and safe auto-restore...');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));

  const reloadStatus = await page.evaluate(async () => {
    const session = await window.godotWebMcpTestBridge.callTool('godot_get_session_status', {});
    const feed = document.getElementById('webmcp-agent-action-feed');
    const resumePanel = document.getElementById('webmcp-resume-panel');
    return {
      session: session.session,
      persistence: session.persistence,
      feedText: feed ? feed.innerText : '',
      hasResumePanel: Boolean(resumePanel)
    };
  });

  console.log('  Reload Session State:', JSON.stringify(reloadStatus, null, 2));
  const reloadShot = path.join(ARTIFACTS_DIR, 'step4_after_reload.png');
  await page.screenshot({ path: reloadShot });
  console.log('  Saved after reload screenshot:', reloadShot);

  await browser.close();
  console.log('\n--- Verification Completed Successfully ---');
}

runVerification().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
