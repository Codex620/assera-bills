// Sends APPROVED bills to Dext by email, once each. The approved list lives in the private reports repo
// (queue/send-queue.json); a record of what was sent lives next to it (queue/sent-ledger.json).
// Needs these Coolify settings: GITHUB_TOKEN, REPORT_REPO, SMTP_USER, SMTP_PASS, DEXT_TO.
// Nothing is emailed unless SEND_ENABLED=true; otherwise it only prints what it WOULD send.
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const H = () => ({ Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'User-Agent': 'assera-bills', Accept: 'application/vnd.github+json' });
const URL_ = (p) => 'https://api.github.com/repos/' + process.env.REPORT_REPO + '/contents/' + p;

async function getJson(p) {
  const r = await fetch(URL_(p), { headers: H() });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error('GitHub read failed for ' + p + ': HTTP ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
}
async function getBinary(p) {
  const r = await fetch(URL_(p), { headers: { ...H(), Accept: 'application/vnd.github.raw' } });
  if (!r.ok) throw new Error('GitHub read failed for ' + p + ': HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function putJson(p, obj, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(URL_(p), { method: 'PUT', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('GitHub write failed for ' + p + ': HTTP ' + r.status);
}

async function run(log) {
  log('=== SENDER ===');
  const need = ['GITHUB_TOKEN', 'REPORT_REPO', 'SMTP_USER', 'SMTP_PASS', 'DEXT_TO'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) { log('Sender not configured. Missing settings:', missing.join(', ')); return; }
  const live = process.env.SEND_ENABLED === 'true';
  log('Mode:', live ? 'LIVE (emails will be sent)' : 'DRY RUN (nothing will be sent)');
  const queue = (await getJson('queue/send-queue.json')).data;
  if (!queue || !Array.isArray(queue.items) || !queue.items.length) { log('No approved items in the queue.'); return; }
  const transporter = live ? nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
  for (const item of queue.items) {
    try {
      const ledger = await getJson('queue/sent-ledger.json');
      const sent = (ledger.data && ledger.data.sent) || [];
      if (sent.find((s) => s.id === item.id)) { log('  already sent, skipping:', item.id); continue; }
      const pdf = await getBinary(item.pdf);
      const sha = crypto.createHash('sha256').update(pdf).digest('hex');
      if (item.sha256 && sha !== item.sha256) { log('  CHECKSUM MISMATCH, not sending:', item.id); continue; }
      if (!live) { log('  WOULD SEND:', item.id, '| subject:', item.subject, '|', pdf.length, 'bytes | to', process.env.DEXT_TO.replace(/(.).+(@.+)/, '$1***$2')); continue; }
      const info = await transporter.sendMail({
        from: process.env.SMTP_USER, to: process.env.DEXT_TO, subject: item.subject, text: item.body,
        attachments: [{ filename: item.filename, content: pdf, contentType: 'application/pdf' }],
      });
      sent.push({ id: item.id, sentAt: new Date().toISOString(), messageId: info.messageId, accepted: (info.accepted || []).length });
      await putJson('queue/sent-ledger.json', { sent }, ledger.sha, 'sent ' + item.id);
      log('  SENT:', item.id, '| accepted by mail server:', (info.accepted || []).length);
    } catch (e) {
      log('  ERROR for', item.id, ':', String(e.message).slice(0, 160));
    }
  }
}
module.exports = { run };
