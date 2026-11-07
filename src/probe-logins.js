// Looks at the PUBLIC login pages of several providers. Uses NO passwords. Sends/changes nothing.
const { publish } = require('./reporter');
const { chromium } = require('playwright');
const mask = (s) => String(s || '').replace(/\d{5,}/g, (m) => '..' + m.slice(-4)).replace(/\s+/g, ' ');
const log = console.log;

const SITES = [
  { name: 'Bell', urls: ['https://my.bell.ca/', 'https://www.bell.ca/Login', 'https://www.bell.ca/'] },
  { name: 'Videotron', urls: ['https://www.videotron.com/en/login', 'https://id.videotron.com/', 'https://www.videotron.com/'] },
];

async function look(page, url) {
  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); ok = true; }
    catch (e) { log('  attempt', i, 'failed:', mask(e.message).slice(0, 70)); await page.waitForTimeout(8000); }
  }
  if (!ok) return false;
  await page.waitForTimeout(10000);
  const status = async (label) => {
    log('  [' + label + '] URL:', mask(page.url()).split('?')[0].slice(0, 110), '| Title:', mask(await page.title()).slice(0, 70));
    for (const f of page.frames()) {
      const inputs = await f.$$eval('input', (els) => els.filter((e) => e.type !== 'hidden' && e.offsetParent !== null)
        .map((e) => [e.type, e.name, e.id, e.placeholder].join('|'))).catch(() => []);
      if (inputs.length) log('    inputs in', mask(f.url()).split('?')[0].slice(0, 60), '=>', mask(inputs.join(' ;; ')).slice(0, 400));
    }
    const btns = await page.$$eval('button, a[role=button], input[type=submit]', (els) => els.filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 40));
    log('    buttons:', mask([...new Set(btns)].slice(0, 14).join(' ;; ')));
    const html = (await page.content()).toLowerCase();
    log('    password box:', !!(await page.$('input[type=password]')), '| captcha:', /captcha|recaptcha|hcaptcha|turnstile|px-captcha/.test(html),
        '| blocked:', /access denied|unusual traffic|are you a robot|request unsuccessful|pardon our interruption|forbidden/.test(html));
  };
  await status('opened');
  if (!(await page.$('input[type=password]'))) {
    const link = page.getByRole('link', { name: /log ?in|sign ?in|my ?account|connexion|se connecter/i }).first();
    const btn = page.getByRole('button', { name: /log ?in|sign ?in|connexion|se connecter/i }).first();
    const target = (await link.count()) ? link : btn;
    if (await target.count()) {
      await target.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(12000);
      await status('after clicking login');
    } else log('    no visible login link/button found');
  }
  return true;
}

async function main() {
  log('REPORT START');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 20000));
  for (const site of SITES) {
    log('=== ' + site.name + ' ===');
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    for (const url of site.urls) {
      log('--- trying', url);
      try { await look(page, url); } catch (e) { log('  ERROR:', mask(e.message).slice(0, 150)); }
    }
    await page.context().close();
  }
  await browser.close();
}
main().finally(async () => { log('REPORT END'); await publish('login-pages'); setInterval(() => {}, 1 << 30); });
