// Enbridge Gas bill retriever, test version 3 (skips MFA, closes popups). Logs in, looks around, tries to capture the current bill.
// Sends nothing, changes nothing. Prints a short masked report. Secrets come from env vars
// ENBRIDGE_USER_1 / ENBRIDGE_PASS_1, then _2, _3.
const { publish } = require('./reporter');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.env.DATA_DIR || '/data';
const mask = (s) => String(s || '')
  .replace(/\d{5,}/g, (m) => '..' + m.slice(-4))
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\(?\d{3}\)?[ -]\d{3}-\d{4}/g, '[phone]')
  .replace(/\s+/g, ' ');
const log = (...a) => console.log(...a);

function pdfLines(file, n) {
  try {
    const txt = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 30000 });
    return txt.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).map((l) => mask(l).slice(0, 100));
  } catch (e) { return ['pdf read error']; }
}
let headPrinted = 0;

async function runLogin(browser, n, user, pass) {
  log('=== ENBRIDGE LOGIN', n, '===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const captured = [];
  context.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('pdf') && resp.status() === 200) {
        const body = await resp.body();
        const file = path.join(OUT, 'enbridge-' + Date.now() + '-' + captured.length + '.pdf');
        fs.writeFileSync(file, body);
        captured.push({ file, size: body.length, url: mask(resp.url()).split('?')[0].slice(0, 90) });
      }
    } catch (e) {}
  });
  page.on('download', async (d) => {
    try {
      const file = path.join(OUT, 'enbridge-dl-' + Date.now() + '.pdf');
      await d.saveAs(file);
      captured.push({ file, size: fs.statSync(file).size, url: 'download:' + mask(d.suggestedFilename()) });
    } catch (e) {}
  });
  const bodyTail = async (from, len) => {
    const t = await page.innerText('body').catch(() => '');
    const i = from ? t.indexOf(from) : -1;
    return mask(t.slice(i < 0 ? 0 : i, (i < 0 ? 0 : i) + len));
  };
  try {
    let opened = false;
    for (let i = 1; i <= 5 && !opened; i++) {
      try { await page.goto('https://myaccount.enbridgegas.com/', { waitUntil: 'load', timeout: 60000 }); opened = true; }
      catch (e) { log('Open attempt', i, 'failed:', mask(e.message).slice(0, 60)); await page.waitForTimeout(10000); }
    }
    if (!opened) throw new Error('Could not open Enbridge after 5 tries');
    await page.waitForSelector('#okta-signin-password', { timeout: 40000 });
    await page.fill('#okta-signin-username', user);
    await page.fill('#okta-signin-password', pass);
    const remember = await page.$('input[name=remember]');
    if (remember && (await remember.isChecked())) await remember.uncheck().catch(() => {});
    await page.click('#okta-signin-submit');
    await page.waitForTimeout(20000);
    // Close optional screens and popups (never enable MFA): click only buttons that are actually visible.
    const dismiss = [
      { name: 'Skip MFA', loc: () => page.getByRole('button', { name: /skip mfa/i }) },
      { name: "Don't show again", loc: () => page.getByText(/don'?t show again/i) },
      { name: 'Ok', loc: () => page.getByRole('button', { name: /^(ok|close|got it|no thanks|maybe later)$/i }) },
    ];
    for (let round = 0; round < 8; round++) {
      let clickedSomething = false;
      for (const d of dismiss) {
        const all = d.loc();
        const n = await all.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const el = all.nth(i);
          if (await el.isVisible().catch(() => false)) {
            log('Popup/optional screen: clicking', d.name);
            await el.click({ timeout: 5000 }).catch(() => {});
            clickedSomething = true;
            await page.waitForTimeout(4000);
            break;
          }
        }
      }
      const loading = /OktaLoading/.test(page.url());
      if (!clickedSomething && !loading) break;
      await page.waitForTimeout(8000);
    }
    await page.waitForURL((u) => !/OktaLoading/.test(String(u)), { timeout: 45000 }).catch(() => log('Still on the loading page after waiting'));
    await page.waitForTimeout(8000);
    const vis = await page.$$eval('button, a[role=button], [role=button]', (els) => els
      .filter((e) => e.offsetParent !== null).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 40));
    log('Visible buttons:', mask([...new Set(vis)].slice(0, 20).join(' ;; ')));
    log('URL after login:', mask(page.url()).split('?')[0].slice(0, 110));
    log('Title:', mask(await page.title()));
    const lower = (await page.innerText('body').catch(() => '')).toLowerCase();
    log('Asks for a code (2-step):', /verification code|security code|one-time|passcode|enter the code|text message|sms|verify it's you/.test(lower));
    log('Error words seen:', /incorrect|invalid|locked|try again|unable to sign/.test(lower));
    log('PAGE:', await bodyTail('', 900));
    const items = await page.$$eval('a, button', (els) => els
      .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') + ' -> ' + (e.getAttribute('href') || '').split('?')[0])
      .filter((x) => /bill|statement|account|history|usage|pdf|download|view/i.test(x)));
    log('BILL-RELATED LINKS:', mask([...new Set(items)].slice(0, 25).join(' ;; ')).slice(0, 1100));

    // try to open the bill
    const target = page.locator('a, button').filter({ hasText: /view (my |current |latest )?bill|current bill|bill history|view bill|billing/i }).first();
    if (await target.count()) {
      await target.click({ timeout: 10000 }).catch((e) => log('click failed:', mask(e.message).slice(0, 90)));
      await page.waitForTimeout(15000);
      log('After clicking bill link, URL:', mask(page.url()).split('?')[0].slice(0, 110));
      log('PAGE 2:', await bodyTail('', 900));
      const items2 = await page.$$eval('a, button', (els) => els
        .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') + ' -> ' + (e.getAttribute('href') || '').split('?')[0])
        .filter((x) => /view|download|pdf|bill|statement/i.test(x)));
      log('LINKS 2:', mask([...new Set(items2)].slice(0, 20).join(' ;; ')).slice(0, 900));
    } else {
      log('No bill link matched on the first page.');
    }
    log('PDFs captured:', captured.length);
    for (const c of captured) {
      log('  PDF', c.size + ' bytes', c.url);
      if (headPrinted < 2) { headPrinted++; log('  PDF TOP LINES:', JSON.stringify(pdfLines(c.file, 40))); }
    }
  } catch (e) {
    log('ERROR:', mask(e.message).slice(0, 300));
  }
  await context.close();
}

async function main() {
  log('REPORT START');
  const logins = [];
  for (let n = 1; n <= 3; n++) {
    const u = process.env['ENBRIDGE_USER_' + n];
    const p = process.env['ENBRIDGE_PASS_' + n];
    if (u && p) logins.push({ n, u, p });
  }
  if (!logins.length) { log('No ENBRIDGE_USER_1 / ENBRIDGE_PASS_1 found in Coolify settings.'); return; }
  log('Logins configured:', logins.length);
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) {}
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 20000));
  for (const l of logins) await runLogin(browser, l.n, l.u, l.p);
  await browser.close();
}
main().finally(async () => { log('REPORT END'); await publish('enbridge'); setInterval(() => {}, 1 << 30); });
