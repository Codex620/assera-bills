// Enbridge Gas bill retriever, test version 5 (accounts list, ViewBill API, activity page). Logs in, looks around, tries to capture the current bill.
// Sends nothing, changes nothing. Prints a short masked report. Secrets come from env vars
// ENBRIDGE_USER_1 / ENBRIDGE_PASS_1, then _2, _3.
const { publish, uploadBinary } = require('./reporter');
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
    // Close optional screens and popups (never enable MFA): click VISIBLE elements by their exact text.
    const WANT = ['skip mfa', "don't show again", 'ok', 'close', 'no thanks', 'maybe later', 'got it'];
    for (let round = 0; round < 10; round++) {
      let clicked = '';
      for (const f of page.frames()) {
        const res = await f.evaluate((want) => {
          const els = [...document.querySelectorAll('button, a, div, span, p, [role=button], input[type=button]')];
          for (const w of want) {
            const hit = els.find((e) => {
              const t = ((e.innerText || e.value || '') + '').trim().toLowerCase().replace(/\s+/g, ' ');
              return t === w && e.getClientRects().length > 0;
            });
            if (hit) { hit.click(); return w; }
          }
          return '';
        }, WANT).catch(() => '');
        if (res) { clicked = res; break; }
      }
      if (clicked) log('Popup/optional screen: clicked "' + clicked + '"');
      const loading = /OktaLoading/.test(page.url());
      await page.waitForTimeout(clicked ? 5000 : 8000);
      if (!clicked && !loading) break;
      if (!clicked && round >= 4) break;
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
    const T = async () => (await page.innerText('body').catch(() => ''));
    const svc = (t) => { const m = t.match(/Service Address:\s*(.+?)\s+Account Number:\s*(\d+)/); return m ? mask(m[1]).slice(0, 50) + ' (acct ..' + m[2].slice(-4) + ')' : 'not found'; };
    log('First account shown:', svc(await T()));

    // 1) list every account offered by the address drop-down
    const opts = await page.$$eval('select option', (els) => els.map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
    log('Drop-down options (select):', mask(opts.join(' ;; ')).slice(0, 700) || 'none');
    const items = await page.$$eval('[role=option], [role=listbox] li, .dropdown-menu li, .dropdown-menu a, ul[class*=account] li, [class*=account-list] li', (els) => els
      .map((e) => (e.innerText || '').trim().replace(/\s+/g, ' ')).filter((t) => /\d/.test(t) && t.length < 90));
    log('Account list items:', mask([...new Set(items)].slice(0, 20).join(' ;; ')).slice(0, 900) || 'none');

    // 2) try the bill download link directly with the logged-in session
    try {
      const r = await page.request.get('https://myaccount.enbridgegas.com/api/MyBillInfo/ViewBill', { timeout: 40000 });
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      const buf = await r.body();
      log('ViewBill API: HTTP', r.status(), '| type', ct.slice(0, 40), '|', buf.length, 'bytes');
      if (ct.includes('pdf') && buf.length > 1000) {
        fs.mkdirSync(path.join(OUT, 'enbridge'), { recursive: true });
        const f = path.join(OUT, 'enbridge', 'login' + n + '-current.pdf');
        fs.writeFileSync(f, buf);
        log('  BILL TOP LINES:', JSON.stringify(pdfLines(f, 45)));
      } else {
        log('  body start:', mask(buf.toString('utf8').slice(0, 300)));
      }
    } catch (e) { log('ViewBill API error:', mask(e.message).slice(0, 120)); }

    // 2b) v6: look for the account switcher near "Service Address" and print the ViewBill page to a PDF
    try {
      await page.goto('https://myaccount.enbridgegas.com/my-account/my-bill', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(8000);
      const sw = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('select, [role=combobox], [aria-haspopup], [class*=ddl], [class*=select], [class*=dropdown], [id*=ddl], [id*=Account], [id*=account]').forEach((e) => {
          out.push(e.tagName + '#' + (e.id || '') + '.' + String(e.className || '').slice(0, 40) + ' [' + (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 70) + ']' + (e.tagName === 'SELECT' ? ' opts=' + [...e.options].map((o) => o.text.trim()).join('|').slice(0, 200) : ''));
        });
        return [...new Set(out)].slice(0, 25);
      });
      log('SWITCHER CANDIDATES:', sw.map(mask).join(' ;; ').slice(0, 1800));
    } catch (e) { log('Switcher error:', mask(e.message).slice(0, 100)); }
    try {
      await page.goto('https://myaccount.enbridgegas.com/api/MyBillInfo/ViewBill', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(6000);
      const txt = await page.innerText('body').catch(() => '');
      log('VIEWBILL TEXT:', mask(txt).slice(0, 900));
      const acct = ((txt.match(/Account (?:Number|#)[:\s]*([\d ]{6,})/i) || [])[1] || 'unknown').replace(/\s/g, '').slice(-4);
      const dm = txt.match(/(?:Bill(?:ing)? date|Statement date|Date issued)[:\s]*([A-Za-z]+\.? \d{1,2}, \d{4})/i);
      const am = txt.match(/(?:Total amount due|Amount due|Total due|Current charges)[:\s]*\$?([\d,]+\.\d{2})/i);
      log('  parsed: acct ..' + acct, '| date', dm ? dm[1] : 'n/a', '| amount', am ? am[1] : 'n/a');
      const pdf = await page.pdf({ format: 'Letter', printBackground: true });
      const name = 'enbridge-pdfs/' + acct + '/login' + n + '_' + new Date().toISOString().slice(0, 10) + '.pdf';
      log('  PDF printed:', pdf.length, 'bytes | repo upload:', await uploadBinary(name, pdf));
    } catch (e) { log('ViewBill print error:', mask(e.message).slice(0, 120)); }

    // 3) the account activity page (payment and bill history)
    try {
      await page.goto('https://myaccount.enbridgegas.com/My-Account/Account-Activity', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(12000);
      const t = await T();
      const i = t.indexOf('Service Address');
      log('ACCOUNT ACTIVITY:', mask(t.slice(i < 0 ? 0 : i, (i < 0 ? 0 : i) + 1300)));
    } catch (e) { log('Activity page error:', mask(e.message).slice(0, 100)); }
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
