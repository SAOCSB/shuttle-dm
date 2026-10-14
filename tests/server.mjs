// Local test server for Shuttle DM: Range support, per-connection throttling, flaky connections,
// Referer/Cookie protected files, HLS (VOD/AES/fMP4/HEVC/live), DASH-style tracks, takeover downloads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

const ROOT = path.resolve(new URL('./assets', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8080);
const log = [];
const conns = new Map();
let connId = 0;
let liveStart = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4',
  '.key': 'application/octet-stream', '.bin': 'application/octet-stream', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.zip': 'application/zip', '.pdf': 'application/pdf',
};

function record(req, extra) {
  log.push({ t: Date.now(), url: req.url, range: req.headers.range || null, referer: req.headers.referer || null, origin: req.headers.origin || null, cookie: req.headers.cookie || null, ...extra });
}

async function sendFile(req, res, file, opts = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { record(req, { status: 404 }); res.writeHead(404); return res.end('not found'); }
  const size = stat.size;
  const headers = { 'Content-Type': opts.type || MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ETag: `"${size}-${Math.round(stat.mtimeMs)}"` };
  if (!opts.noRange) headers['Accept-Ranges'] = 'bytes';
  if (opts.disposition) headers['Content-Disposition'] = opts.disposition;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && !opts.noRange) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
      if (start >= size) { record(req, { status: 416 }); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  record(req, { status, start, end });
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
  const rate = opts.rate || 0;
  const cutAfter = opts.flaky ? (1 + Math.random() * 3) * 1024 * 1024 : 0;
  let sent = 0;
  const cid = ++connId;
  const info = { url: req.url, range: range || null, sent: 0, state: 'start', t: Date.now() };
  conns.set(cid, info);
  res.on('close', () => { stream.destroy(); conns.delete(cid); });
  try {
    for await (const chunk of stream) {
      if (res.destroyed) break;
      if (cutAfter && sent + chunk.length > cutAfter && end - start + 1 > cutAfter) {
        res.write(chunk.subarray(0, Math.max(0, Math.floor(cutAfter - sent))));
        info.state = 'cutting';
        await sleep(20);
        res.destroy();
        return;
      }
      const ok = res.write(chunk);
      sent += chunk.length;
      info.sent = sent;
      info.t = Date.now();
      if (rate) { info.state = 'sleep'; await sleep((chunk.length / rate) * 1000); }
      else if (!ok) { info.state = 'drain'; await Promise.race([once(res, 'drain'), once(res, 'close')]); }
      info.state = 'read';
    }
    info.state = 'end';
    res.end();
  } catch {
    res.destroy();
  }
}

function livePlaylist() {
  if (!liveStart) liveStart = Date.now();
  const total = 12;
  const elapsed = (Date.now() - liveStart) / 1000;
  const available = Math.min(total, 4 + Math.floor(elapsed / 2));
  const first = Math.max(0, available - 4);
  let s = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
  for (let i = first; i < available; i++) s += `#EXTINF:2.000000,\nseg_${String(i).padStart(3, '0')}.ts\n`;
  if (available >= total && elapsed > 30) s += '#EXT-X-ENDLIST\n';
  return s;
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>示例视频页面 - 飞梭测试站</title>
<style>body{font-family:sans-serif;margin:24px;background:#fafafa} video{display:block;background:#000} .row{margin:12px 0}</style></head>
<body><h1>示例视频页面</h1>
<video id="v" src="/media/video.mp4" controls width="720" height="405" muted preload="auto"></video>
<div class="row"><a id="big" href="/files/big.bin">big.bin</a> · <a id="zip" href="/download/report.zip">下载报告（zip）</a> · <a href="/docs/manual.pdf">manual.pdf</a> · <a href="/files/norange.bin">norange.bin</a></div>
<div class="row"><img src="/img/logo.png" alt="logo" width="64"> <img src="/img/photo.png" alt="photo" width="64"></div>
<p><a id="php" href="/download.php?id=7">下载年度报告</a></p>
<p id="sel">选中这段文字里的链接：<a href="/files/flaky.bin">flaky.bin</a> 和 <a href="/files/cookie.bin">cookie.bin</a>。</p>
<script>
document.cookie = 'auth=ok; path=/';
fetch('/hls/ts/master.m3u8').then(r => r.text()).then(() => fetch('/hls/ts/stream_720p.m3u8'));
fetch('/dash/video.m4s', { headers: { Range: 'bytes=0-999' } });
fetch('/dash/audio.m4s', { headers: { Range: 'bytes=0-999' } });
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(u.pathname);
  if (p === '/__log') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (p === '/__conns') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([...conns.values()].map(c => ({ ...c, age: Date.now() - c.t })))); }
  if (p === '/__reset') { log.length = 0; liveStart = null; res.writeHead(200); return res.end('ok'); }
  if (p === '/' || p === '/page.html') { record(req, { status: 200 }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (p.startsWith('/img/')) {
    // tiny generated PNG (1x1)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    return res.end(png);
  }
  if (p === '/files/big.bin') return sendFile(req, res, `${ROOT}/big.bin`, { rate: 4 * 1024 * 1024 });
  if (p === '/files/slow.bin') return sendFile(req, res, `${ROOT}/big.bin`, { rate: 768 * 1024 });
  if (p === '/files/fast.bin') return sendFile(req, res, `${ROOT}/big.bin`);
  if (p === '/files/norange.bin') return sendFile(req, res, `${ROOT}/big.bin`, { noRange: true, rate: 16 * 1024 * 1024 });
  if (p === '/files/flaky.bin' || p.startsWith('/files/flaky.bin')) return sendFile(req, res, `${ROOT}/big.bin`, { flaky: true });
  if (p === '/files/referer.bin') {
    if (!String(req.headers.referer || '').startsWith(`http://127.0.0.1:${PORT}/page`)) { record(req, { status: 403 }); res.writeHead(403); return res.end('forbidden'); }
    return sendFile(req, res, `${ROOT}/big.bin`);
  }
  if (p === '/files/cookie.bin') {
    if (!/auth=ok/.test(req.headers.cookie || '')) { record(req, { status: 403 }); res.writeHead(403); return res.end('need cookie'); }
    return sendFile(req, res, `${ROOT}/big.bin`);
  }
  if (p === '/download/report.zip') {
    return sendFile(req, res, `${ROOT}/big.bin`, { type: 'application/zip', disposition: "attachment; filename=\"report.zip\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%8A%A5%E5%91%8A.zip", rate: 8 * 1024 * 1024 });
  }
  if (p === '/download/small.zip') {
    return sendFile(req, res, `${ROOT}/hls/ts/v360p_000.ts`, { type: 'application/zip', disposition: 'attachment; filename="small.zip"' });
  }
  if (p.startsWith('/hls-slow/')) return sendFile(req, res, path.join(ROOT, 'hls', p.slice('/hls-slow/'.length)), { rate: 160 * 1024 });
  if (p.startsWith('/dash-slow/')) return sendFile(req, res, path.join(ROOT, 'dash', p.slice('/dash-slow/'.length)), { rate: 400 * 1024 });
  if (p === '/download.php') {
    return sendFile(req, res, `${ROOT}/big.bin`, { type: 'application/octet-stream', disposition: "attachment; filename*=UTF-8''%E5%B9%B4%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf", rate: 8 * 1024 * 1024 });
  }
  if (p === '/live/live.m3u8') { record(req, { status: 200 }); res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }); return res.end(livePlaylist()); }
  if (p.startsWith('/live/')) return sendFile(req, res, `${ROOT}/live/${path.basename(p)}`);
  if (p.startsWith('/hls-ref/')) {
    if (!String(req.headers.referer || '').startsWith(`http://127.0.0.1:${PORT}/`)) { record(req, { status: 403 }); res.writeHead(403); return res.end('forbidden'); }
    return sendFile(req, res, path.join(ROOT, 'hls', p.slice('/hls-ref/'.length)));
  }
  if (p.startsWith('/hls/') || p.startsWith('/dash/')) return sendFile(req, res, path.join(ROOT, p.slice(1)));
  if (p === '/media/video.mp4') return sendFile(req, res, `${ROOT}/video.mp4`);
  record(req, { status: 404 });
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => console.log(`test server on http://127.0.0.1:${PORT}`));
