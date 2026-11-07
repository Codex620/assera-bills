// Copies everything printed with console.log, and at the end saves it as a file in a PRIVATE
// GitHub repository (REPORT_REPO, using GITHUB_TOKEN). Both come from Coolify settings, never from code.
const lines = [];
const original = console.log;
console.log = (...a) => { original(...a); lines.push(a.map(String).join(' ')); };

function scrub(text) {
  let t = text;
  for (const [k, v] of Object.entries(process.env)) {
    if (/USER|PASS|TOKEN|SECRET/i.test(k) && v && v.length >= 4) t = t.split(v).join('[secret]');
  }
  return t;
}

async function publish(name) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPORT_REPO; // e.g. Codex620/assera-reports
  if (!token || !repo) { original('(report not saved: GITHUB_TOKEN or REPORT_REPO not set)'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = name + '/' + stamp + '.txt';
  const content = Buffer.from(scrub(lines.join('\n') + '\n')).toString('base64');
  try {
    const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + file, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'assera-bills' },
      body: JSON.stringify({ message: 'report ' + name + ' ' + stamp, content }),
    });
    original(res.ok ? 'Report saved to ' + repo + '/' + file : 'Report NOT saved: HTTP ' + res.status);
  } catch (e) {
    original('Report NOT saved:', String(e.message).slice(0, 100));
  }
}

async function uploadBinary(repoPath, buffer) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPORT_REPO;
  if (!token || !repo) return 'not configured';
  try {
    const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + repoPath, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'assera-bills' },
      body: JSON.stringify({ message: 'bill pdf ' + repoPath, content: buffer.toString('base64') }),
    });
    if (res.ok) return 'saved';
    if (res.status === 422) return 'already there';
    return 'HTTP ' + res.status;
  } catch (e) { return 'failed ' + String(e.message).slice(0, 60); }
}

module.exports = { publish, uploadBinary };
