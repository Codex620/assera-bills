// Enbridge Gas: look at the PUBLIC login page only. Uses NO password. Sends/changes nothing.
const { chromium } = require('playwright');
const mask = (s) => String(s || '').replace(/\d{5,}/g, (m) => '..' + m.slice(-4)).replace(/\s+/g, ' ');
const log = console.log;

const CANDIDATES = [
  'https://www.enbridgegas.com/my-account',
  'https://myaccount.enbridgegas.com/',
  'https://www.enbridgegas.com/',
];

async function main() {
  log('REPORT START');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 20000)); // let the server network settle
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  for (const url of CANDIDATES) {
    log('--- Trying', url);
    try {
      let ok = false;
      for (let i = 1; i <= 4 && !ok; i++) {
        try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); ok = true; }
        catch (e) { log('  attempt', i, 'failed:', mask(e.message).slice(0, 60)); await page.waitForTimeout(8000); }
      }
      if (!ok) continue;
      await page.waitForTimeout(8000);
      log('  Final URL:', mask(page.url()).split('?')[0].slice(0, 110));
      log('  Title:', mask(await page.title()));
      // if there is a visible Login / Sign in link, click it once and look again
      const link = page.getByRole('link', { name: /log ?in|sign ?in|my ?account/i }).first();
      if (!(await page.$('input[type=password]')) && (await link.count())) {
        await link.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(10000);
        log('  After clicking login link, URL:', mask(page.url()).split('?')[0].slice(0, 110));
      }
      const frames = page.frames();
      for (const f of frames) {
        const inputs = await f.$$eval('input', (els) => els.filter((e) => e.type !== 'hidden')
          .map((e) => [e.type, e.name, e.id, e.placeholder].join('|'))).catch(() => []);
        if (inputs.length) log('  Inputs in', mask(f.url()).split('?')[0].slice(0, 60), '=>', mask(inputs.join(' ;; ')).slice(0, 500));
      }
      const btns = await page.$$eval('button, input[type=submit]', (els) => els
        .map((e) => (e.innerText || e.value || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 40));
      log('  Buttons:', mask([...new Set(btns)].slice(0, 12).join(' ;; ')));
      const html = (await page.content()).toLowerCase();
      log('  Password box present:', !!(await page.$('input[type=password]')));
      log('  Captcha mentioned:', /captcha|recaptcha|hcaptcha|turnstile/.test(html));
      log('  Blocked text:', /access denied|unusual traffic|are you a robot|request unsuccessful/.test(html));
    } catch (e) {
      log('  ERROR:', mask(e.message).slice(0, 200));
    }
  }
  await browser.close();
}
main().finally(() => { log('REPORT END'); setInterval(() => {}, 1 << 30); });
