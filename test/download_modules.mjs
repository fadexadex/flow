import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

async function fetchModules() {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto('https://codex-modeling-studio.openai.chatgpt.site/');

  const moduleUrls = [
    'https://codex-modeling-studio.openai.chatgpt.site/modules/tool-definitions.js',
    'https://codex-modeling-studio.openai.chatgpt.site/modules/camera-guidance.js',
    'https://codex-modeling-studio.openai.chatgpt.site/modules/studio-public-tool-catalog.js',
    'https://codex-modeling-studio.openai.chatgpt.site/modules/studio-public-tool-protocol.js'
  ];

  for (const url of moduleUrls) {
    try {
      const resp = await page.goto(url);
      const text = await resp.text();
      const filename = path.basename(url);
      fs.writeFileSync(`test/${filename}`, text);
      console.log(`Saved test/${filename} (${text.length} bytes)`);
    } catch (err) {
      console.error(`Failed ${url}:`, err.message);
    }
  }

  await browser.close();
}

fetchModules().catch(console.error);
