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
  bell: { label: 'Bell', env: 'BELL', urls: ['https://m.bell.ca/bbebillviewbille', 'https://identification.bell.ca/'] },
  videotron: { label: 'Videotron', env: 'VIDEOTRON', urls: ['https://www.videotron.com/en/login'] },
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
  const state = async (label) => {
    const html = (await page.content().catch(() => '')).toLowerCase();
    const text = (await page.innerText('body').catch(() => ''));
    const t = text.toLowerCase();
    log('  [' + label + '] ' + mask(page.url()).split('?')[0].slice(0, 100) + ' | title: ' + mask(await page.title().catch(() => '')).slice(0, 60));
    log('    captcha:', /captcha|turnstile|px-captcha/.test(html), '| asks for a code:', /verification code|one-time|passcode|enter the code|code de vérification|text message|sms/.test(t), '| error words:', /incorrect|invalid|locked|try again|erreur|invalide/.test(t));
    log('    text:', mask(text).slice(0, 300));
    return { captcha: /captcha|turnstile|px-captcha/.test(html), code: /verification code|one-time|passcode|enter the code|code de vérification/.test(t) };
  };
  try {
    let opened = false;
    for (const u of P.urls) { for (let i = 1; i <= 3 && !opened; i++) { try { await page.goto(u, { waitUntil: 'load', timeout: 60000 }); opened = true; } catch (e) { await page.waitForTimeout(8000); } } if (opened) break; }
    if (!opened) { log('  could not open ' + P.label + ' (is the sign-in address set?)'); await context.close(); return; }
    await page.waitForTimeout(10000);
    let s = await state('opened');
    const typeFirst = async (value, kind) => {
      for (const f of page.frames()) {
        const sel = kind === 'pass' ? 'input[type=password]:visible' : 'input[type=email]:visible, input[name=identifier]:visible, input[name=username]:visible, input[id*=user i]:visible, input[id*=email i]:visible, input[type=text]:visible';
        const el = f.locator(sel).first();
        if (await el.count().catch(() => 0)) { await el.fill(value, { timeout: 8000 }).catch(() => {}); return { f, el }; }
      }
      return null;
    };
    const press = async (f) => {
      const b = f.locator('button:visible, input[type=submit]:visible').filter({ hasText: /next|continue|suivant|continuer|sign in|log in|login|connexion|se connecter|submit|ok/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {}); else await page.keyboard.press('Enter');
    };
    if (!(await page.$('input[type=password]'))) { const u = await typeFirst(user, 'user'); if (u) { await press(u.f); await page.waitForTimeout(12000); s = await state('after user name'); } else log('  no user-name box found'); }
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
    if (!pw) { log('  no password box found'); await context.close(); return; }
    await press(pw.f); await page.waitForTimeout(15000);
    s = await state('after password');
    if (s.captcha || s.code) { log('  STOP: ' + (s.code ? 'a security code is requested' : 'a captcha is shown') + '. The robot will not enter codes or solve captchas.'); await context.close(); return; }
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
