// Hydro One bill retriever, test version 6 (several logins, all accounts, last N bills each).
// Downloads bill PDFs into DATA_DIR/hydroone/<account last 4>/<bill date>_<amount>.pdf and prints a masked table.
// Sends nothing, changes nothing. Secrets come from env vars HYDROONE_USER_n / HYDROONE_PASS_n.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.env.DATA_DIR || '/data';
const ACCOUNT_LIMIT = parseInt(process.env.ACCOUNT_LIMIT || '4', 10);
const BILL_LIMIT = parseInt(process.env.BILL_LIMIT || '3', 10);
const PICKER = 'https://www.hydroone.com/myaccount/select-account/?returnUrl=/myaccount';

const mask = (s) => String(s || '')
  .replace(/\d{5,}/g, (m) => '..' + m.slice(-4))
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\(?\d{3}\)?[ -]\d{3}-\d{4}/g, '[phone]')
  .replace(/\s+/g, ' ');
const log = (...a) => console.log(...a);
const sleep = (page, ms) => page.waitForTimeout(ms);

function parseBill(file) {
  try {
    const txt = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 30000 });
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
    const grab = (re) => { const m = txt.match(re); return m ? m[1].trim() : ''; };
    const postal = [];
    lines.forEach((l, i) => { if (/\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/.test(l)) postal.push(((lines[i - 1] || '') + ' / ' + l).slice(0, 110)); });
    const svc = lines.filter((l) => /service (address|location)|supply address|location of service/i.test(l)).slice(0, 2);
    return {
      issued: grab(/statement is issued on:\s*([A-Za-z]+ \d{1,2}, \d{4})/i),
      period: grab(/for the period of:\s*([^\n]+)/i),
      account: mask(grab(/account number is:\s*([\d ]+)/i)),
      owner: lines.find((l) => /INC\.|LTD|CORP/i.test(l)) || '',
      addressLines: postal.slice(0, 3).map(mask),
      serviceLabelLines: svc.map(mask),
    };
  } catch (e) { return { error: mask(e.message).slice(0, 100) }; }
}

async function runLogin(browser, n, user, pass) {
  log('=== LOGIN', n, '===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const captured = [];
  context.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('pdf') && resp.status() === 200) {
        const body = await resp.body();
        const file = path.join(OUT, 'tmp-' + Date.now() + '-' + captured.length + '.pdf');
        fs.writeFileSync(file, body);
        captured.push({ file, size: body.length });
      }
    } catch (e) {}
  });
  page.on('download', async (d) => {
    try {
      const file = path.join(OUT, 'tmp-dl-' + Date.now() + '.pdf');
      await d.saveAs(file);
      captured.push({ file, size: fs.statSync(file).size });
    } catch (e) {}
  });

  try {
    let opened = false;
    for (let i = 1; i <= 5 && !opened; i++) {
      try { await page.goto('https://www.hydroone.com/myaccount', { waitUntil: 'load', timeout: 60000 }); opened = true; }
      catch (e) { log('Open attempt', i, 'failed:', mask(e.message).slice(0, 60)); await sleep(page, 10000); }
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
    log('ACCOUNTS:', accounts.map((a) => '..' + a.last4 + ' ' + a.addr).join(' | ') || 'none parsed');
    const count = await page.getByRole('button', { name: 'SELECT', exact: true }).count();

    for (let idx = 0; idx < Math.min(count, ACCOUNT_LIMIT); idx++) {
      const a = accounts[idx] || { last4: 'acct' + (idx + 1), addr: '' };
      log('--- ACCOUNT ..' + a.last4, a.addr, '---');
      try {
        await page.goto(PICKER, { waitUntil: 'load', timeout: 60000 }); await sleep(page, 8000);
        await page.getByRole('button', { name: 'SELECT', exact: true }).nth(idx).click({ timeout: 15000 });
        await sleep(page, 8000);
        await page.getByText('View past bills').first().click({ timeout: 10000 });
        await sleep(page, 10000);
        try { await page.getByText(/Show \d+ more months/).first().click({ timeout: 5000 }); await sleep(page, 3000); } catch (e) {}

        const body = await page.innerText('body').catch(() => '');
        const rows = [...body.matchAll(/([A-Z][a-z]{2} \d{1,2}, \d{4})\s+Billed amount\s+\$([\d,]+\.\d{2})/g)]
          .map((m) => ({ date: m[1], amount: m[2].replace(',', '') }))
          .filter((r, i, arr) => i === 0 || r.date !== arr[i - 1].date || r.amount !== arr[i - 1].amount);
        const toggles = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('[href^="#billingDetails"]').forEach((e) => { const h = e.getAttribute('href'); if (!out.includes(h)) out.push(h); });
          return out;
        });
        log('  billed rows:', rows.length, '| toggles:', toggles.length);

        for (let k = 0; k < Math.min(BILL_LIMIT, rows.length, toggles.length); k++) {
          captured.length = 0;
          const row = rows[k];
          const id = toggles[k].slice(1);
          let status = '';
          try {
            await page.evaluate((h) => { const el = document.querySelector('[href="' + h + '"]'); if (el) el.click(); }, toggles[k]);
            await sleep(page, 2500);
            for (const label of [/download bill/i, /view bill/i]) {
              if (captured.length) break;
              const link = page.locator('#' + id + ' a, #' + id + ' button').filter({ hasText: label }).first();
              if (await link.count()) {
                await link.click({ timeout: 8000, force: true }).catch(() => {});
                for (let w = 0; w < 12 && !captured.length; w++) await sleep(page, 1000);
              }
            }
            if (!captured.length) { status = 'NO PDF CAPTURED'; }
            else {
              const c = captured[0];
              const [mon, day, year] = row.date.replace(',', '').split(' ');
              const mm = String(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(mon) + 1).padStart(2, '0');
              const dir = path.join(OUT, 'hydroone', a.last4);
              fs.mkdirSync(dir, { recursive: true });
              const dest = path.join(dir, year + '-' + mm + '-' + String(day).padStart(2, '0') + '_' + row.amount + '.pdf');
              fs.copyFileSync(c.file, dest);
              status = 'saved ' + path.relative(OUT, dest) + ' ' + c.size + 'b ' + JSON.stringify(parseBill(dest));
            }
          } catch (e) { status = 'ERROR ' + mask(e.message).slice(0, 100); }
          log('  BILL', k + 1, row.date, '$' + row.amount, '=>', status);
          for (const c of captured) { try { fs.unlinkSync(c.file); } catch (e) {} }
          captured.length = 0;
        }
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
  log('Logins configured:', logins.length, '| accounts per login:', ACCOUNT_LIMIT, '| bills per account:', BILL_LIMIT);
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) {}
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 20000));
  for (const l of logins) await runLogin(browser, l.n, l.u, l.p);
  await browser.close();
}
main().finally(() => { log('REPORT END'); setInterval(() => {}, 1 << 30); });
