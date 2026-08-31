import puppeteer from 'puppeteer-core';
import fs from 'fs';

async function fetchUI() {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const resp = await page.goto('https://codex-modeling-studio.openai.chatgpt.site/modules/studio-ui.js');
  const text = await resp.text();
  fs.writeFileSync('test/studio-ui.js', text);
  console.log('Saved test/studio-ui.js, length:', text.length);

  await browser.close();
}

fetchUI().catch(console.error);
