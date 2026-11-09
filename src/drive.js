// Copies bill PDFs into the Assera Google Drive folder. Needs two Coolify settings on the Hydro One robot:
//   GOOGLE_SA_JSON  (secret: the whole service-account key file, entered by Marc)
//   DRIVE_FOLDER_ID (the folder id; not secret)
// The folder must be shared with the service account (or live in a Shared Drive it belongs to).
const crypto = require('crypto');
let cached = null;
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'RS256', typ: 'JWT' });
  const claim = b({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google sign-in failed: ' + String(j.error_description || j.error || r.status).slice(0, 80));
  cached = { t: j.access_token, exp: Date.now() + 3000 * 1000 };
  return cached.t;
}
async function upload(name, buf) {
  const t = await token();
  const folder = process.env.DRIVE_FOLDER_ID;
  const q = encodeURIComponent("name='" + name.replace(/'/g, "\\'") + "' and '" + folder + "' in parents and trashed=false");
  const ex = await (await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&q=' + q, { headers: { Authorization: 'Bearer ' + t } })).json();
  if (ex.files && ex.files.length) return ex.files[0].id; // already in the folder
  const boundary = 'assera' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [folder] });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n'),
    buf, Buffer.from('\r\n--' + boundary + '--'),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
  const j = await r.json();
  if (!j.id) throw new Error('Drive upload failed: ' + String((j.error && j.error.message) || r.status).slice(0, 100));
  return j.id;
}
module.exports = { upload, enabled: () => !!(process.env.GOOGLE_SA_JSON && process.env.DRIVE_FOLDER_ID) };
