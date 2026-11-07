// Hydro One bill retriever, test version 4 (several logins, past bills).
// Logs in once, visits every account, captures the current-bill PDF and probes "past bills".
// Sends nothing, changes nothing. Prints a short, masked report. Secrets come from env vars.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.env.DATA_DIR || '/data';
const PICKER = 'https://www.hydroone.com/myaccount/select-account/?returnUrl=/myaccount';

const mask = (s) => String(s || '')
  .replace(/\d{5,}/g, (m) => '..' + m.slice(-4))
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\(?\d{3}\)?[ -]\d{3}-\d{4}/g, '[phone]')
  .replace(/\s+/g, ' ');
const log = (...a) => console.log(...a);
const sleep = (page, ms) => page.waitForTimeout(ms);

function pdfSummary(file) {
  try {
    const txt = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 30000 });
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
    const keep = lines.filter((l) =>
      /(service address|account (number|no)|bill (date|number)|billing period|bill period|amount due|total (amount|due|bill)|due date|invoice|statement date|previous bill|current charges)/i.test(l));
    return { pages: (txt.match(/\f/g) || []).length, lineCount: lines.length, keep: keep.slice(0, 14).map((l) => mask(l).slice(0, 110)) };
  } catch (e) {
    return { error: mask(e.message).slice(0, 120) };
  }
}

function pdfHead(file) {
  try {
    const txt = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 30000 });
    return txt.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 45).map((l) => mask(l).slice(0, 100));
  } catch (e) { return ['pdf read error']; }
}
let headPrinted = 0;

async function runLogin(browser, n, user, pass) {
  log('=== LOGIN', n, '===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();

  // Capture every PDF the site hands us, whether by download, popup or inline response.
  const captured = [];
  context.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('pdf') && resp.status() === 200) {
        const body = await resp.body();
        const file = path.join(OUT, 'capture-' + Date.now() + '-' + captured.length + '.pdf');
        fs.writeFileSync(file, body);
        captured.push({ file, size: body.length, url: mask(resp.url()).split('?')[0].slice(0, 90) });
      }
    } catch (e) {}
  });
  page.on('download', async (d) => {
    try {
      const file = path.join(OUT, 'download-' + Date.now() + '.pdf');
      await d.saveAs(file);
      captured.push({ file, size: fs.statSync(file).size, url: 'download:' + mask(d.suggestedFilename()) });
    } catch (e) { log('download save failed:', mask(e.message).slice(0, 80)); }
  });

  try {
    let opened = false;
    for (let i = 1; i <= 5 && !opened; i++) {
      try {
        await page.goto('https://www.hydroone.com/myaccount', { waitUntil: 'load', timeout: 60000 });
        opened = true;
      } catch (e) {
        log('Open attempt', i, 'failed:', mask(e.message).slice(0, 60));
        await sleep(page, 10000);
      }
    }
    if (!opened) throw new Error('Could not open Hydro One after 5 tries');
    await page.waitForSelector('input[type=password]', { timeout: 30000 });
    await page.fill('#username', user);
    await page.fill('#password', pass);
    const remember = await page.$('#remember-my-email');
    if (remember && (await remember.isChecked())) await remember.uncheck();
    await Promise.all([page.waitForLoadState('load', { timeout: 60000 }).catch(() => {}), page.click('#btnSubmit')]);
    await sleep(page, 12000);

    const pickerText = await page.innerText('body').catch(() => '');
    const accounts = [...pickerText.matchAll(/Account\s+(\d{5,})[\s\S]{0,80}?Addresses\s+([^\n]+?)\s+(?:[A-Z][a-z]+\s+ON|Balance)/g)]
      .map((m) => ({ last4: m[1].slice(-4), addr: mask(m[2]).slice(0, 60) }));
    log('ACCOUNTS FOUND:', accounts.length ? accounts.map((a) => '..' + a.last4 + ' ' + a.addr).join(' | ') : 'none parsed');
    const count = await page.getByRole('button', { name: 'SELECT', exact: true }).count();
    log('SELECT buttons:', count);

    for (let idx = 0; idx < Math.min(count, 4); idx++) {
      log('--- ACCOUNT', idx + 1, accounts[idx] ? '(..' + accounts[idx].last4 + ')' : '', '---');
      captured.length = 0;
      try {
        if (idx > 0) { await page.goto(PICKER, { waitUntil: 'load', timeout: 60000 }); await sleep(page, 10000); }
        await page.getByRole('button', { name: 'SELECT', exact: true }).nth(idx).click({ timeout: 15000 });
        await sleep(page, 10000);

        // 1) current bill
        try {
          await page.getByText('View current bill').first().click({ timeout: 10000 });
          await sleep(page, 15000);
        } catch (e) { log('current bill click failed:', mask(e.message).slice(0, 80)); }
        log('After current bill: pdfs captured =', captured.length, '| pages open =', context.pages().length);
        for (const c of captured) {
          log('  PDF', path.basename(c.file), c.size + ' bytes', c.url);
          log('  SUMMARY', JSON.stringify(pdfSummary(c.file)));
        }
        if (!captured.length) {
          const t = await page.innerText('body').catch(() => '');
          log('  No PDF. Page text after click:', mask(t.slice(t.indexOf('Logout') + 6)).slice(0, 500));
        }

        // 2) past bills page
        captured.length = 0;
        await page.goto(PICKER, { waitUntil: 'load', timeout: 60000 }); await sleep(page, 8000);
        await page.getByRole('button', { name: 'SELECT', exact: true }).nth(idx).click({ timeout: 15000 });
        await sleep(page, 8000);
        await page.getByText('View past bills').first().click({ timeout: 10000 });
        await sleep(page, 12000);
        const t2 = await page.innerText('body').catch(() => '');
        const i2 = t2.indexOf('Logout');
        log('  PAST BILLS PAGE:', mask(t2.slice(i2 < 0 ? 0 : i2 + 6)).slice(0, 900));
        const items = await page.$$eval('a, button', (els) => els
          .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') + ' -> ' + (e.getAttribute('href') || '').split('?')[0])
          .filter((x) => /view|download|pdf|bill/i.test(x)));
        log('  PAST BILLS ITEMS:', mask([...new Set(items)].slice(0, 14).join(' ;; ')).slice(0, 700));

        // show older months, then list every billed / payment row
        try { await page.getByText(/Show \d+ more months/).first().click({ timeout: 6000 }); await sleep(page, 4000); } catch (e) {}
        const hist = await page.innerText('body').catch(() => '');
        const rowsTxt = [...hist.matchAll(/([A-Z][a-z]{2} \d{1,2}, \d{4})\s+(Billed amount|Payment received for)\s+\$([\d,]+\.\d{2})/g)]
          .map((m) => m[1] + ' ' + (m[2].startsWith('Billed') ? 'BILLED' : 'PAID') + ' ' + m[3]);
        log('  HISTORY ROWS (' + rowsTxt.length + '):', rowsTxt.join(' | '));

        // expand the newest past bill and look for a PDF link inside
        captured.length = 0;
        try {
          await page.locator('a[href="#billingDetails0"]').first().click({ timeout: 8000 });
          await sleep(page, 3000);
          const det = await page.locator('#billingDetails0').innerText({ timeout: 5000 }).catch(() => '');
          log('  EXPANDED BILL DETAILS:', mask(det).slice(0, 600));
          const inner = await page.$$eval('#billingDetails0 a, #billingDetails0 button', (els) => els
            .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') + ' -> ' + (e.getAttribute('href') || '').split('?')[0]));
          log('  LINKS INSIDE EXPANDED BILL:', mask(inner.join(' ;; ')).slice(0, 400) || 'NONE');
          const target = page.locator('#billingDetails0').getByText(/view|download|pdf|bill/i).first();
          if (await target.count()) {
            await target.click({ timeout: 8000 }).catch((e) => log('  click failed:', mask(e.message).slice(0, 80)));
            await sleep(page, 14000);
            log('  PDFs captured from past bill:', captured.length);
            for (const c of captured) {
              log('  PAST PDF', c.size + ' bytes', 'summary', JSON.stringify(pdfSummary(c.file)));
              if (headPrinted < 2) { headPrinted++; log('  PDF TOP LINES:', JSON.stringify(pdfHead(c.file))); }
            }
          }
        } catch (e) { log('  expand step note:', mask(e.message).slice(0, 120)); }
      } catch (e) {
        log('  Account ERROR:', mask(e.message).slice(0, 200));
      }
    }
  } catch (e) {
    log('ERROR:', mask(e.message).slice(0, 300));
  }
  await context.close();
}

async function main() {
  log('REPORT START');
  const logins = [];
  for (let n = 1; n <= 5; n++) {
    const u = process.env['HYDROONE_USER_' + n];
    const p = process.env['HYDROONE_PASS_' + n];
    if (u && p) logins.push({ n, u, p });
  }
  if (!logins.length) { log('No HYDROONE_USER_1 / HYDROONE_PASS_1 found in Coolify settings.'); return; }
  log('Logins configured:', logins.length);
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) {}
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 20000)); // let the server network settle after start
  for (const l of logins) await runLogin(browser, l.n, l.u, l.p);
  await browser.close();
}

main().finally(() => {
  log('REPORT END');
  setInterval(() => {}, 1 << 30); // keep container alive so Coolify does not restart it
});
