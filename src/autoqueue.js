// Adds NEW bills to the approved send list (queue/send-queue.json in the private reports repo).
// Rule agreed with Marc: a bill is queued once, if it was issued on/after AUTOQUEUE_FROM (default 2026-09-10),
// it is not already in the queue, the sent ledger or the skip list. The sender (sender.js) then emails it once.
// Set AUTOQUEUE=false to turn this off.
const crypto = require('crypto');
const { getJson, putJson } = require('./sender');
const FROM = process.env.AUTOQUEUE_FROM || '2026-09-10';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseDate(str) { // "November 3, 2026" or "Nov 03, 2026" -> {iso, short:"Nov 3", year}
  const m = String(str || '').match(/([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const i = FULL.findIndex((f) => f.toLowerCase().startsWith(m[1].slice(0, 3).toLowerCase()));
  if (i < 0) return null;
  return { iso: m[3] + '-' + String(i + 1).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0'), short: MON[i] + ' ' + parseInt(m[2], 10), year: m[3], label: MON[i] + ' ' + parseInt(m[2], 10) + ', ' + m[3] };
}
function periodText(a, b) { return a.short + ' to ' + b.short + ', ' + b.year; }

// b: { source: 'hydroone'|'enbridge', acct, amount, issued (text), periodFrom (text), periodTo (text), property, note, pdfPath (path in reports repo), pdf (Buffer) }
async function addIfNew(log, b) {
  try {
    if (process.env.AUTOQUEUE === 'false') return;
    const issued = parseDate(b.issued), from = parseDate(b.periodFrom), to = parseDate(b.periodTo);
    if (!issued || !from || !to || !b.amount) { log('  autoqueue: could not read date/period/amount for ..' + b.acct + ', not queued'); return; }
    if (issued.iso < FROM) return;
    const id = b.source + '-' + b.acct + '-' + issued.iso + '-' + b.amount;
    const q = await getJson('queue/send-queue.json');
    const queue = q.data || { items: [] };
    const ledger = (await getJson('queue/sent-ledger.json')).data || { sent: [] };
    const skip = (await getJson('queue/skip-list.json')).data || { skip: [] };
    if (queue.items.find((x) => x.id === id) || (ledger.sent || []).find((x) => x.id === id) || (skip.skip || []).includes(id)) return;
    const per = periodText(from, to);
    const hydro = b.source === 'hydroone';
    queue.items.push({
      id, pdf: b.pdfPath, sha256: crypto.createHash('sha256').update(b.pdf).digest('hex'),
      filename: (hydro ? 'HydroOne_' : 'Enbridge_') + b.property.replace(/\s+/g, '-') + '_' + issued.iso + '_' + b.amount + '.pdf',
      subject: (hydro ? 'Hydro One - ' : 'Enbridge Gas - ') + b.property + ' - ' + per + ' - $' + b.amount,
      body: (hydro ? 'Statement issued ' : 'Bill date ') + issued.label + '. Account ending ' + b.acct + '. Property: ' + b.property + (b.note ? ' (' + b.note + ')' : '') + '. Billing period: ' + per + '.\nNew bill queued automatically by the Assera bills robot. Please match it to the Assera transaction.',
    });
    await putJson('queue/send-queue.json', queue, q.sha, 'auto-queue ' + id);
    log('  autoqueue: queued', id);
  } catch (e) { log('  autoqueue error:', String(e.message).slice(0, 120)); }
}
module.exports = { addIfNew };
