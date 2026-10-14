// Checks that video detection and downloading are switched off on YouTube (store policy),
// while the same page on another site still works.
// A local HTTPS server stands in for both sites; the browser maps their names to it.
// Run: node blocked-sites.mjs   (no test server needed)
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, sleep, HERE, WORK } from './harness.mjs';

const PORT = 8443;
const ASSETS = path.join(HERE, 'assets');
const TLS = path.join(WORK, 'tls');
fs.mkdirSync(TLS, { recursive: true });
if (!fs.existsSync(path.join(TLS, 'cert.pem'))) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
    '-keyout', path.join(TLS, 'key.pem'), '-out', path.join(TLS, 'cert.pem')], { stdio: 'ignore' });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test video</title></head><body>
<video id="v" src="/media/video.mp4" controls width="720" height="405" muted preload="auto"></video>
<script>fetch('/hls/ts/master.m3u8').then((r) => r.text()).then(() => fetch('/hls/ts/stream_720p.m3u8'));</script>
</body></html>`;

const server = https.createServer({ key: fs.readFileSync(path.join(TLS, 'key.pem')), cert: fs.readFileSync(path.join(TLS, 'cert.pem')) }, (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  if (p === '/watch') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  const file = path.join(ASSETS, p.replace(/^\/media\//, '/'));
  if (!file.startsWith(ASSETS) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const { browser, ext, send } = await launch(path.join(WORK, 'profile-blocked'), {
  args: [
    `--host-resolver-rules=MAP www.youtube.com:443 127.0.0.1:${PORT}, MAP media.example.org:443 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors', '--no-proxy-server',
  ],
});
const extId = new URL(ext.url()).host;
let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

async function visit(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const tabId = await ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  const view = await send('getTabMedia', { tabId });
  // hover the video: the "Download video" button is added to the page only where the content script runs
  const box = await (await page.$('#v')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await sleep(800);
  const overlay = await page.evaluate(() => !!document.querySelector('shuttle-dm-overlay'));
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${extId}/ui/popup.html?tabId=${tabId}`);
  await sleep(1500);
  const popupText = await pop.evaluate(() => document.querySelector('#mediaList').innerText);
  await pop.close();
  return { entries: view.entries || [], overlay, popupText, page };
}

try {
  const yt = await visit('https://www.youtube.com/watch');
  check(yt.entries.length === 0, 'youtube: nothing is detected', `${yt.entries.length} entries`);
  check(!yt.overlay, 'youtube: no "Download video" button on the page');
  const msg = await ext.evaluate(() => chrome.i18n.getMessage('blockedSiteMessage'));
  check(yt.popupText.includes(msg), 'youtube: popup explains the site is not supported', JSON.stringify(yt.popupText.slice(0, 80)));
  const r = await send('addDownload', { task: { url: 'https://rr1---sn-test.googlevideo.com/videoplayback?id=1' } });
  check(!!r.error && r.error.includes(msg), 'youtube: video host addresses are refused', r.error || JSON.stringify(r));

  const ok = await visit('https://media.example.org/watch');
  check(ok.entries.length >= 2, 'other site: video and HLS are detected', ok.entries.map((e) => e.kind).join(','));
  check(ok.overlay, 'other site: "Download video" button appears');
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
