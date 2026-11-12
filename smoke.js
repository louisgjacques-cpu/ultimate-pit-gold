const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 760, height: 820 } }); const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push(m.text()); }); page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('tShells').textContent === '51 of 51', null, { timeout: 120000 });
  const hdr = await page.$eval('#hdr', e => Math.round(e.getBoundingClientRect().height));
  console.log('ok:', await page.$eval('#bigVal', e => e.textContent), await page.$eval('#pill', e => e.textContent), '| header height at 760px:', hdr, '|', errs.length ? errs.join('; ') : 'no console errors');
  await browser.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
