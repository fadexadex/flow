import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

async function fetchAndAnalyzeBootstrap() {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const response = await page.goto('https://codex-modeling-studio.openai.chatgpt.site/bootstrap.js');
  const jsContent = await response.text();

  fs.writeFileSync('test/codex_bootstrap.js', jsContent);
  console.log('Saved test/codex_bootstrap.js, bytes:', jsContent.length);

  await browser.close();
}

fetchAndAnalyzeBootstrap().catch(console.error);
