// Attach files to a Jira issue via the Jira Cloud REST API.
//
// Usage:
//   JIRA_BASE=https://your-org.atlassian.net \
//   JIRA_EMAIL=you@your-org.example          \
//   JIRA_TOKEN=<your-api-token>              \
//   node scripts/attach-to-jira.cjs <ISSUE-KEY> path/to/file1.png path/to/file2.zip ...
//
// Get your API token at:
//   https://id.atlassian.com/manage-profile/security/api-tokens
//
// First run: store JIRA_EMAIL + JIRA_TOKEN in your shell's env (or in a
// gitignored .env.jira file) so subsequent attachments are one-liners.

const fs = require('node:fs');
const path = require('node:path');

const BASE   = process.env.JIRA_BASE;
const EMAIL  = process.env.JIRA_EMAIL;
const TOKEN  = process.env.JIRA_TOKEN;

if (!BASE || !EMAIL || !TOKEN) {
  console.error('Missing JIRA_BASE / JIRA_EMAIL / JIRA_TOKEN env vars.');
  console.error('Get your token at https://id.atlassian.com/manage-profile/security/api-tokens');
  console.error('Then run: JIRA_BASE=https://your-org.atlassian.net JIRA_EMAIL=you@... JIRA_TOKEN=... node scripts/attach-to-jira.cjs <KEY> <FILE>...');
  process.exit(1);
}

const [, , issueKey, ...files] = process.argv;
if (!issueKey || files.length === 0) {
  console.error('Usage: node scripts/attach-to-jira.cjs <ISSUE-KEY> <FILE> [FILE ...]');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

(async () => {
  const url = `${BASE}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
  let okCount = 0;
  let failCount = 0;
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      console.error(`  ✗ ${filePath} — file not found`);
      failCount++;
      continue;
    }
    const buf = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === '.png'   ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webm'  ? 'video/webm' :
      ext === '.mp4'   ? 'video/mp4' :
      ext === '.zip'   ? 'application/zip' :
      ext === '.json'  ? 'application/json' :
      ext === '.txt'   ? 'text/plain' :
      'application/octet-stream';

    // Build a multipart/form-data body manually (no extra deps).
    const boundary = '----simqaJiraBoundary' + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);

    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'X-Atlassian-Token': 'no-check',  // required by Jira to bypass XSRF check
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (res.ok) {
      let attId = '';
      try { const j = JSON.parse(text); attId = j[0]?.id ? `id=${j[0].id} ` : ''; } catch {}
      console.log(`  ✓ ${filename}  (${(buf.length / 1024).toFixed(0)} KB, ${ms}ms) ${attId}`);
      okCount++;
    } else {
      console.error(`  ✗ ${filename}  HTTP ${res.status}: ${text.slice(0, 200)}`);
      failCount++;
    }
  }
  console.log(`\n${okCount}/${files.length} attached to ${issueKey}: ${BASE}/browse/${issueKey}`);
  process.exit(failCount > 0 ? 1 : 0);
})();
