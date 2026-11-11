// Generic bill-portal robot for Bell, Videotron and the two water providers (Ottawa, Clarence-Rockland).
// Run it in the "Login page checks" app with SCRIPT=portal.js. Logins come from Coolify variables, per provider:
//   BELL_USER_1 / BELL_PASS_1, VIDEOTRON_USER_1 / VIDEOTRON_PASS_1 (_2 ...), OTTAWAWATER_USER_1 / _PASS_1, ROCKLANDWATER_USER_1 / _PASS_1
//   Water providers also need the sign-in page address: OTTAWAWATER_URL, ROCKLANDWATER_URL.
//   PROVIDERS=bell,videotron,ottawawater,rocklandwater (default: all that have a user and password).
// Stage 1 (this version): sign in, report what the page shows (masked), try to open and download bills, save PDFs to the private reports repo.
// It never types a code or solves a captcha: if one appears it stops and says so. Sends nothing.
const { publish, uploadBinary } = require('./reporter');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.env.DATA_DIR || '/data';
const mask = (s) => String(s || '').replace(/\d{5,}/g, (m) => '..' + m.slice(-4)).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\(?\d{3}\)?[ -]\d{3}-\d{4}/g, '[phone]').replace(/\s+/g, ' ');
const log = (...a) => console.log(...a);
const PROVIDERS = {
  bell: { label: 'Bell', env: 'BELL', urls: ['https://identification.bell.ca/', 'https://www.bell.ca/'] },
  videotron: { label: 'Videotron', env: 'VIDEOTRON', urls: ['https://www.videotron.com/en/signin', 'https://www.videotron.com/en/'] },
  ottawawater: { label: 'Ottawa water', env: 'OTTAWAWATER', urls: [process.env.OTTAWAWATER_URL].filter(Boolean) },
  rocklandwater: { label: 'Clarence-Rockland water', env: 'ROCKLANDWATER', urls: [process.env.ROCKLANDWATER_URL].filter(Boolean) },
};
const BILL_WORDS = /bill|statement|invoice|facture|relev|download|télécharg|view pdf|pdf/i;

async function loginAndLook(browser, key, n, user, pass) {
  const P = PROVIDERS[key];
  log('=== ' + P.label + ' login ' + n + ' ===');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const captured = [];
  context.on('response', async (resp) => { try { if ((resp.headers()['content-type'] || '').toLowerCase().includes('pdf') && resp.status() === 200) { const b = await resp.body(); if (b.length > 3000) captured.push({ buf: b, name: 'resp' }); } } catch (e) {} });
  page.on('download', async (d) => { try { const f = path.join(OUT, 'dl-' + Date.now() + '.pdf'); await d.saveAs(f); captured.push({ buf: fs.readFileSync(f), name: mask(d.suggestedFilename()) }); fs.unlinkSync(f); } catch (e) {} });
  page.on('requestfailed', (r) => { if (r.isNavigationRequest()) log('    navigation failed:', mask(r.url()).split('?')[0].slice(0, 100), '|', mask(r.failure() && r.failure().errorText).slice(0, 50)); });
  const state = async (label) => {
    const text = (await page.innerText('body').catch(() => ''));
    const t = text.toLowerCase();
    const challenge = await page.evaluate(() => {
      const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const fr = [...document.querySelectorAll('iframe')].some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha.*challenge|challenges\.cloudflare/i.test(f.src || '') && vis(f) && f.getBoundingClientRect().height > 60);
      const px = !!document.querySelector('#px-captcha');
      return fr || (px && vis(document.querySelector('#px-captcha')));
    }).catch(() => false) || /i'?m not a robot|verify (that )?you('| a)re (a )?human|je ne suis pas un robot|press (and|&) hold/i.test(t);
    const hasPw = !!(await page.$('input[type=password]:visible').catch(() => null));
    const codeAsk = !hasPw && /verification code|enter the code|passcode|code de vérification|enter the \d.digit/.test(t);
    log('  [' + label + '] ' + mask(page.url()).split('?')[0].slice(0, 100) + ' | title: ' + mask(await page.title().catch(() => '')).slice(0, 60));
    log('    captcha challenge visible:', challenge, '| asks for a code:', codeAsk, '| error words:', /incorrect|invalid|locked|try again|erreur|invalide/.test(t));
    log('    text:', mask(text).slice(0, 300));
    return { captcha: challenge, code: codeAsk };
  };
  try {
    let opened = false;
    for (const u of P.urls) { for (let i = 1; i <= 3 && !opened; i++) { try { await page.goto(u, { waitUntil: 'load', timeout: 60000 }); opened = true; } catch (e) { await page.waitForTimeout(8000); } } if (opened) break; }
    if (!opened) { log('  could not open ' + P.label + ' (is the sign-in address set?)'); await context.close(); return; }
    await page.waitForTimeout(10000);
    let s = await state('opened');
    const typeFirst = async (value, kind) => {
      for (const f of page.frames()) {
        const NOT = ':not(footer *):not([class*=newsletter i] *):not([class*=infolettre i] *):not([id*=newsletter i]):not([name*=newsletter i]):not([id*=infolettre i]):not([name*=infolettre i]):not([name*=search i]):not([id*=search i]):not([type=search])';
        const sel = kind === 'pass' ? 'input[type=password]:visible' : ['input[type=email]', 'input[name=identifier]', 'input[name=username]', 'input[id*=user i]', 'input[id*=email i]', 'input[type=text]'].map((x) => x + ':visible' + NOT).join(', ');
        const el = f.locator(sel).first();
        if (await el.count().catch(() => 0)) {
          const desc = await el.evaluate((e) => e.tagName.toLowerCase() + '[type=' + e.type + ' name=' + (e.name || '') + ' id=' + (e.id || '') + ']').catch(() => '?');
          await el.fill(value, { timeout: 8000 }).catch(() => {});
          let got = await el.inputValue().catch(() => '');
          if (got.length !== value.length) { await el.click({ timeout: 5000 }).catch(() => {}); await el.fill('').catch(() => {}); await el.pressSequentially(value, { delay: 40 }).catch(() => {}); got = await el.inputValue().catch(() => ''); }
          const ok = got === value;
          log('    ' + kind + ' field ' + mask(desc) + ': holds the expected text ' + (ok ? 'yes' : 'NO (' + got.length + ' of ' + value.length + ' characters)'));
          return ok ? { f, el } : { f, el, bad: true };
        }
      }
      return null;
    };
    const press = async (f) => {
      const b = f.locator('button:visible, input[type=submit]:visible').filter({ hasText: /next|continue|suivant|continuer|sign in|log in|login|connexion|se connecter|submit|ok/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {}); else await page.keyboard.press('Enter');
    };
    const haveBox = async () => { for (const f of page.frames()) { if (await f.locator('input[type=password]:visible, input[name=identifier]:visible, input[name=username]:visible').count().catch(() => 0)) return true; } return false; };
    if (!(await haveBox())) {
      const lk = page.locator('a:visible, button:visible').filter({ hasText: /^\s*(log ?in|sign ?in|connexion|se connecter|my account|mon compte)\s*$/i }).first();
      if (await lk.count().catch(() => 0)) { log('  clicking the site\'s sign-in link'); await lk.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(12000); s = await state('after sign-in link'); }
    }
    {
      const pwNow = !!(await page.$('input[type=password]:visible'));
      const u = await typeFirst(user, 'user'); // always type the user name first, also on one-page forms
      if (u && u.bad) { log('  STOP: the user-name box did not accept the text, nothing submitted.'); await context.close(); return; }
      if (u && !pwNow) { await press(u.f); await page.waitForTimeout(12000); s = await state('after user name'); }
      else if (!u && !pwNow) log('  no user-name box found');
    }
    if (s.captcha) { log('  STOP: a captcha is shown. The robot will not solve it.'); await context.close(); return; }
    if (!(await page.$('input[type=password]:visible'))) {
      // Some portals (Videotron) offer to email a link first: choose the password option instead.
      for (const f of page.frames()) {
        const opt = f.locator('a:visible, button:visible, [role=button]:visible, [role=link]:visible, label:visible').filter({ hasText: /(use|enter|sign in with|log in with|utiliser|entrer|connexion avec)?\s*(my |your |mon |votre )?(password|mot de passe)/i }).filter({ hasNotText: /forgot|oubli|reset|réinit/i }).first();
        if (await opt.count().catch(() => 0)) { log('  choosing the password option'); await opt.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(8000); break; }
      }
      await state('after choosing password');
    }
    const pw = await typeFirst(pass, 'pass');
    if (!pw) { log('  no password box found'); const vis = await page.$$eval('a, button, [role=button], [role=link]', (els) => els.filter((e) => e.getClientRects().length > 0).map((e) => ((e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '[' + (e.getAttribute('href') || '').slice(0, 45) + ']')).filter((t) => t.length > 2).slice(0, 40)); log('  visible links/buttons:', mask(vis.join(' ;; ')).slice(0, 1500)); await context.close(); return; }
    if (pw.bad) { log('  STOP: the password box did not accept the text, nothing submitted.'); await context.close(); return; }
    await press(pw.f); await page.waitForTimeout(15000);
    s = await state('after password');
    if (s.captcha || s.code) { log('  STOP: ' + (s.code ? 'a security code is requested' : 'a captcha is shown') + '. The robot will not enter codes or solve captchas.'); await context.close(); return; }
    if (key === 'rocklandwater') {
      // City of Clarence-Rockland (iCity): accounts list -> click an account row -> Billing summary (slow to load) -> bill
      let sumText = '';
      const feed = page.url();
      const rowCount = await page.locator('table tbody tr').count().catch(() => 0);
      const rowTexts = await page.$$eval('table tbody tr', (trs) => trs.slice(0, 10).map((t) => (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140))).catch(() => []);
      log('  accounts list rows:', rowCount, '|', mask(rowTexts.join(' ;; ')).slice(0, 900));
      for (let r = 0; r < Math.min(rowCount, 6); r++) {
        try {
          if (r > 0) { await page.goto(feed, { waitUntil: 'load', timeout: 60000 }); await page.waitForTimeout(6000); }
          captured.length = 0;
          if (/PT-|Property Tax/i.test(rowTexts[r] || '')) { log('  row ' + (r + 1) + ': property tax account, skipped'); continue; }
          if (/Invalid PIN/i.test(rowTexts[r] || '')) { log('  row ' + (r + 1) + ': NOT LINKED (Invalid PIN), cannot be read until the account is re-linked with the correct PIN'); continue; }
          await page.locator('table tbody tr').nth(r).click({ timeout: 10000 });
          await page.waitForTimeout(10000);
          await state('opened account row ' + (r + 1));
          const tabs = await page.$$eval('a, button, li', (els) => els.filter((e) => e.getClientRects().length > 0).map((e) => (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)).filter((t) => t && t.length < 30)).catch(() => []);
          log('  tabs/links here:', mask([...new Set(tabs)].slice(0, 40).join(' ;; ')).slice(0, 700));
          const bs = page.getByText(/billing summary|sommaire de (la )?facturation/i).first();
          if (await bs.count().catch(() => 0)) {
            await bs.click({ timeout: 10000 }).catch(() => {});
            for (let w = 0; w < 90; w++) { await page.waitForTimeout(1000); const t = (await page.innerText('body').catch(() => '')); if (captured.length || /\$\s?\d|balance|solde|statement|facture/i.test(t) && w > 10) break; }
            await state('billing summary (row ' + (r + 1) + ')');
            const bl = await page.$$eval('a, button', (els) => els.filter((e) => e.getClientRects().length > 0).map((e) => ((e.innerText || e.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40) + ' [' + (e.getAttribute('href') || '').slice(0, 70) + ']')).filter((t) => /bill|invoice|facture|pdf|view|download|print|imprim|statement|relev/i.test(t)).slice(0, 20)).catch(() => []);
            log('  bill links in the summary:', mask(bl.join(' ;; ')).slice(0, 1000));
            sumText = await page.innerText('body').catch(() => '');
            log('  summary text:', mask(sumText).slice(0, 1600));
            const hrefs = await page.$$eval('a[href*="eDocs.aspx"]', (as) => [...new Set(as.map((a) => a.href))].slice(0, 6)).catch(() => []);
            log('  View (eDocs) links found:', hrefs.length);
            for (let k = 0; k < hrefs.length; k++) {
              try {
                const resp = await page.request.get(hrefs[k], { timeout: 60000 });
                const ct = (resp.headers()['content-type'] || '').toLowerCase(); const body = await resp.body();
                log('    View ' + (k + 1) + ': HTTP', resp.status(), ct.slice(0, 30), body.length, 'bytes');
                if (ct.includes('pdf') && body.length > 3000) captured.push({ buf: body, name: 'edoc' + k });
                else log('      start:', mask(body.toString('utf8').slice(0, 250)));
              } catch (e) { log('    View ' + (k + 1) + ' error:', mask(e.message).slice(0, 100)); }
            }
            if (false && bl.length && !captured.length) {
              const target = page.locator('a, button').filter({ hasText: /view bill|download|pdf|bill|facture|print|statement/i }).first();
              if (await target.count().catch(() => 0)) { await target.click({ timeout: 8000 }).catch(() => {}); for (let w = 0; w < 30 && !captured.length; w++) await page.waitForTimeout(1000); }
            }
          } else log('  no Billing summary link on this account page');
          log('  PDFs captured for row ' + (r + 1) + ':', captured.length);
          for (let ci = 0; ci < captured.length; ci++) {
            const c = captured[ci]; fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, 'rockland-' + r + '-' + ci + '.pdf'); fs.writeFileSync(f, c.buf);
            let top = []; try { top = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', timeout: 30000 }).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30).map((x) => mask(x).slice(0, 100)); } catch (e) {}
            log('  top lines:', JSON.stringify(top));
            log('  repo upload:', await uploadBinary('rocklandwater-pdfs/row' + (r + 1) + '/' + new Date().toISOString().slice(0, 10) + '_' + (ci + 1) + '.pdf', c.buf));
            try {
              // The newest bill is the first row of the Billing Summary table: date, View, amount, bill from, bill to.
              const m = sumText.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+View\s+\$([\d,]+\.\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
              const txt = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', timeout: 30000 });
              const addr = ((txt.match(/Service Address[^:\n]*:\s*(\d+ [A-Z][A-Z ]*?)\s*(?:\n|\*|\s{2,}|$)/) || [])[1] || '').trim();
              const bd = (txt.match(/Billing Date[^:\n]*:\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/) || []);
              const acctNo = ((txt.match(/Account #[^:\n]*:\s*([\d ]+)/) || [])[1] || '').replace(/\s/g, '');
              const props = JSON.parse(process.env.ROCKLAND_PROPERTY_MAP || '{"715 POWERS":"715 Powers St","717 POWERS":"717 Powers St"}');
              const mdy = (x) => { const a = x.split('/'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+a[0] - 1] + ' ' + (+a[1]) + ', ' + a[2]; };
              if (m && bd.length && props[addr] && acctNo) {
                const issued = bd[2] + ' ' + (+bd[1]) + ', ' + bd[3];
                if (mdy(m[1]) === issued) {
                  const pdfPath = 'rocklandwater-pdfs/' + acctNo.slice(-4) + '/' + new Date(issued).toISOString().slice(0, 10) + '_' + m[2].replace(',', '') + '.pdf';
                  await uploadBinary(pdfPath, c.buf);
                  await require('./autoqueue').addIfNew(log, { source: 'rocklandwater', acct: acctNo.slice(-4), amount: m[2].replace(',', ''), issued, periodFrom: mdy(m[3]), periodTo: mdy(m[4]), property: props[addr], note: 'City of Clarence-Rockland water and sewer', pdfPath, pdf: c.buf });
                } else log('  not queued: first summary row (' + m[1] + ') is not this bill (' + issued + ')');
              } else log('  not queued: could not read the bill details (address "' + mask(addr) + '")');
            } catch (e) { log('  autoqueue skipped:', mask(e.message).slice(0, 100)); }
          }
        } catch (e) { log('  row ' + (r + 1) + ' error:', mask(e.message).slice(0, 140)); }
      }
      await context.close(); return;
    }
    // look for bill links and try to capture PDFs
    const links = await page.$$eval('a, button', (els) => els.filter((e) => e.offsetParent !== null).map((e) => ({ t: (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50), h: (e.getAttribute('href') || '').slice(0, 70) })).filter((x) => x.t));
    const first = /billing summary|sommaire de (la )?facturation|billing/i;
    const billish = links.filter((l) => BILL_WORDS.test(l.t) || BILL_WORDS.test(l.h) || first.test(l.t)).sort((a, b) => (first.test(b.t) ? 1 : 0) - (first.test(a.t) ? 1 : 0)).slice(0, 12);
    log('  bill-related links:', mask(billish.map((l) => l.t + ' [' + l.h + ']').join(' ;; ')).slice(0, 900) || 'none');
    for (let i = 0; i < Math.min(3, billish.length) && !captured.length; i++) {
      const l = billish[i];
      await page.getByText(l.t, { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
      const slow = key === 'rocklandwater' ? 90 : 15; // Clarence-Rockland's billing summary is slow to load
      for (let w = 0; w < slow && !captured.length; w++) await page.waitForTimeout(1000);
      if (key === 'rocklandwater') { await state('billing summary after waiting'); const more = await page.$$eval('a, button', (els) => els.filter((e) => e.offsetParent !== null).map((e) => ((e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50) + ' [' + (e.getAttribute('href') || '').slice(0, 70) + ']')).filter((t) => /bill|invoice|facture|pdf|view|download|print|imprim/i.test(t)).slice(0, 15)); log('  links on this page:', mask(more.join(' ;; ')).slice(0, 900)); }
      if (!captured.length) await state('after clicking "' + mask(l.t) + '"');
    }
    log('  PDFs captured:', captured.length);
    if (captured.length) {
      fs.mkdirSync(OUT, { recursive: true });
      const c = captured[0]; const f = path.join(OUT, key + '-' + n + '.pdf'); fs.writeFileSync(f, c.buf);
      let top = []; try { top = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', timeout: 30000 }).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30).map((x) => mask(x).slice(0, 100)); } catch (e) {}
      log('  top lines:', JSON.stringify(top));
      log('  repo upload:', await uploadBinary(key + '-pdfs/login' + n + '/' + new Date().toISOString().slice(0, 10) + '.pdf', c.buf));
    }
  } catch (e) { log('  ERROR:', mask(e.message).slice(0, 200)); }
  await context.close();
}

async function main() {
  log('REPORT START');
  const want = (process.env.PROVIDERS || Object.keys(PROVIDERS).join(',')).split(',').map((x) => x.trim()).filter((x) => PROVIDERS[x]);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await new Promise((r) => setTimeout(r, 15000));
  for (const key of want) {
    let any = false;
    for (let n = 1; n <= 3; n++) {
      const u = process.env[PROVIDERS[key].env + '_USER_' + n], p = process.env[PROVIDERS[key].env + '_PASS_' + n];
      if (u && p) { any = true; await loginAndLook(browser, key, n, u, p); }
    }
    if (!any) log('=== ' + PROVIDERS[key].label + ': skipped (no ' + PROVIDERS[key].env + '_USER_1 and ' + PROVIDERS[key].env + '_PASS_1 set in Coolify) ===');
  }
  await browser.close();
}
main().finally(async () => { log('REPORT END'); await publish('portals'); setInterval(() => {}, 1 << 30); });
