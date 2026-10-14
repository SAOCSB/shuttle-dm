// End-to-end tests for Shuttle DM in headful Chromium (run under xvfb-run).
import fs from 'node:fs';
import path from 'node:path';
import { launch, attachEngineConsole, waitTask, sha256, probe, decodeOk, serverLog, sleep, SERVER, DL, WORK, HERE } from './harness.mjs';

const BIG_SHA = sha256(path.join(HERE, 'assets/big.bin'));
const PROFILE = path.join(WORK, 'profile-e2e');
const only = process.argv.slice(2);
const results = [];

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

let ctx = await launch(PROFILE);
let { browser, send, ext, extId } = ctx;
await send('ensureEngine');
if (process.env.ENGINE_LOG) await attachEngineConsole(browser, extId);

const page = await browser.newPage();
await page.goto(`${SERVER}/page.html`);
await sleep(2500);
const tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
let view = await send('getTabMedia', { tabId });

async function test(name, fn) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, secs: ((Date.now() - t0) / 1000).toFixed(1), detail: detail || '' });
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${detail || ''}`);
  } catch (e) {
    results.push({ name, ok: false, secs: ((Date.now() - t0) / 1000).toFixed(1), detail: String(e?.message || e) });
    console.log(`FAIL ${name}: ${e?.stack || e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function add(task) {
  const r = await send('addDownload', { task });
  if (r.error) throw new Error(r.error);
  assert(r.ids?.length, 'no task id: ' + JSON.stringify(r));
  return r.ids[0];
}
const rel = (p) => path.relative(DL, p || '');

await test('sniff: entries', async () => {
  const kinds = view.entries.map((e) => e.kind);
  assert(kinds.includes('hls') && kinds.includes('merge') && kinds.includes('video'), 'kinds ' + kinds);
  const hls = view.entries.find((e) => e.kind === 'hls');
  assert(hls.choices.length === 2, 'hls choices');
  assert(hls.meta.some((m) => /^\d\d:\d\d/.test(m)), 'hls duration missing: ' + hls.meta.join(','));
  return view.entries.map((e) => `${e.kind}:${(e.choices || []).length}`).join(' ');
});

await test('http: multi-connection + dynamic split', async () => {
  await serverLog(true);
  const id = await add({ url: `${SERVER}/files/big.bin` });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const log = (await serverLog()).filter((x) => x.url === '/files/big.bin');
  assert(log.length >= 8, 'expected >=8 range requests, got ' + log.length);
  return `${rel(t.savedPath)} requests=${log.length}`;
});

await test('http: pause & resume', async () => {
  await serverLog(true);
  const id = await add({ url: `${SERVER}/files/slow.bin` });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 8e6, 30000);
  await send('taskAction', { action: 'pause', ids: [id] });
  const p = await waitTask(send, id, (t) => t.state === 'paused', 15000);
  const at = p.received;
  await sleep(800);
  const logBefore = (await serverLog()).length;
  await send('taskAction', { action: 'resume', ids: [id] });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const after = (await serverLog()).slice(logBefore).filter((x) => x.url === '/files/slow.bin');
  const firstAfter = after[0];
  assert(firstAfter && firstAfter.start > 0, 'resume did not continue from offset: ' + JSON.stringify(firstAfter));
  return `paused at ${(at / 1e6).toFixed(1)}MB, resumed with range ${firstAfter.range}`;
});

await test('http: server without Range support', async () => {
  await serverLog(true);
  const id = await add({ url: `${SERVER}/files/norange.bin` });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const log = (await serverLog()).filter((x) => x.url === '/files/norange.bin');
  assert(log.every((x) => x.status === 200), 'expected only 200s');
  return `requests=${log.length} resumable=${t.resumable}`;
});

await test('http: flaky connections are retried', async () => {
  await serverLog(true);
  const id = await add({ url: `${SERVER}/files/flaky.bin` });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const log = (await serverLog()).filter((x) => x.url === '/files/flaky.bin');
  return `requests=${log.length}`;
});

await test('http: Referer rule (DNR) for hotlink-protected file', async () => {
  const bad = await add({ url: 'http://localhost:8080/files/referer.bin' });
  const tb = await waitTask(send, bad);
  assert(tb.state === 'error' && /403/.test(tb.error), 'expected 403 without referer, got ' + tb.state + ' ' + tb.error);
  await send('taskAction', { action: 'remove', ids: [bad] });
  const good = await add({ url: 'http://localhost:8080/files/referer.bin', referer: `${SERVER}/page.html` });
  const t = await waitTask(send, good);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  return 'without referer → 403; with referer → ok';
});

await test('http: cookies are sent', async () => {
  const id = await add({ url: `${SERVER}/files/cookie.bin` });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  return rel(t.savedPath);
});

async function checkVideo(t, { minDur = 23, maxDur = 25, streams = 2 } = {}) {
  assert(t.state === 'completed', t.error);
  const p = probe(t.savedPath);
  const ok = decodeOk(t.savedPath);
  assert(ok === true, 'decode errors: ' + ok);
  assert(p.streams.length === streams, 'streams: ' + p.streams.join(', '));
  assert(p.duration >= minDur && p.duration <= maxDur, 'duration ' + p.duration);
  return `${rel(t.savedPath)} ${p.format.split(',')[0]} ${p.duration.toFixed(2)}s [${p.streams.join(' | ')}]${t.note ? ' note=' + t.note : ''}`;
}

await test('hls: master → 720p → MP4', async () => {
  const e = view.entries.find((x) => x.kind === 'hls');
  const id = await add(e.choices[0].params);
  return checkVideo(await waitTask(send, id));
});

await test('hls: AES-128 encrypted', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls/aes/index.m3u8`, filename: 'aes测试.mp4' });
  return checkVideo(await waitTask(send, id));
});

await test('hls: fMP4 segments', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls/fmp4/index.m3u8`, filename: 'fmp4测试.mp4' });
  return checkVideo(await waitTask(send, id));
});

await test('hls: HEVC falls back to TS', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls/hevc/index.m3u8`, filename: 'hevc测试.mp4' });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(t.savedPath.endsWith('.ts'), 'expected .ts, got ' + t.savedPath);
  const p = probe(t.savedPath);
  return `${rel(t.savedPath)} [${p.streams.join(' | ')}] note=${t.note}`;
});

await test('hls: hotlink-protected playlist + segments', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls-ref/ts/master.m3u8`, referer: `${SERVER}/page.html`, filename: 'ref测试.mp4' });
  return checkVideo(await waitTask(send, id));
});

await test('dash: separate video + audio tracks merged', async () => {
  const e = view.entries.find((x) => x.kind === 'merge');
  const id = await add(e.choices[0].params);
  return checkVideo(await waitTask(send, id), { minDur: 23.9, maxDur: 24.2 });
});

await test('hls: live recording, stop & save', async () => {
  await fetch(`${SERVER}/__reset`);
  const id = await add({ type: 'hls', url: `${SERVER}/live/live.m3u8`, filename: '直播录制.mp4' });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.hls?.live, 20000);
  await sleep(9000);
  await send('taskAction', { action: 'stop', ids: [id] });
  const t = await waitTask(send, id);
  return checkVideo(t, { minDur: 7, maxDur: 24 });
});

await test('takeover: browser download handed to engine', async () => {
  const before = (await send('listTasks')).tasks.length;
  await page.click('#zip');
  const t0 = Date.now();
  let task = null;
  while (Date.now() - t0 < 20000) {
    const { tasks } = await send('listTasks');
    task = tasks.find((x) => x.source === 'takeover');
    if (task) break;
    await sleep(300);
  }
  assert(task, 'no takeover task created (tasks ' + before + ')');
  const t = await waitTask(send, task.id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const items = await ext.evaluate(async () => (await chrome.downloads.search({ urlRegex: 'report\\.zip' })).map((d) => ({ state: d.state, filename: d.filename })));
  assert(items.length === 0, 'original browser download still present: ' + JSON.stringify(items));
  return `${rel(t.savedPath)}`;
});

await test('takeover: small file left to the browser', async () => {
  await page.goto(`${SERVER}/download/small.zip`).catch(() => {});
  await sleep(2500);
  const items = await ext.evaluate(async () => (await chrome.downloads.search({ urlRegex: 'small\\.zip' })).map((d) => ({ state: d.state, filename: d.filename, byExt: d.byExtensionId || null })));
  assert(items.length === 1 && items[0].state === 'complete' && !items[0].byExt, JSON.stringify(items));
  await page.goto(`${SERVER}/page.html`);
  await sleep(1500);
  return path.basename(items[0].filename);
});

await test('page: save as MHTML', async () => {
  const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
  const r = await send('savePage', { tabId: pageTab, format: 'mhtml' });
  assert(r.ids?.length, JSON.stringify(r));
  const t = await waitTask(send, r.ids[0], undefined, 30000);
  assert(t.state === 'completed', t.error);
  const head = fs.readFileSync(t.savedPath, 'utf8').slice(0, 400);
  assert(/MIME-Version|Content-Type: multipart\/related/i.test(head), 'not mhtml: ' + head.slice(0, 100));
  return rel(t.savedPath);
});

for (let i = 2; i <= (Number(process.env.REPEAT_MHTML) || 1); i++) {
  await test(`page: save as MHTML (repeat ${i})`, async () => {
    const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
    const r = await send('savePage', { tabId: pageTab, format: 'mhtml' });
    assert(r.ids?.length, JSON.stringify(r));
    const t = await waitTask(send, r.ids[0], undefined, 30000);
    assert(t.state === 'completed', t.error);
    return rel(t.savedPath);
  });
}

await test('page: save as HTML snapshot', async () => {
  const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
  const r = await send('savePage', { tabId: pageTab, format: 'html' });
  const t = await waitTask(send, r.ids[0], undefined, 30000);
  assert(t.state === 'completed', t.error);
  const html = fs.readFileSync(t.savedPath, 'utf8');
  assert(html.includes('<base href="http://127.0.0.1:8080/page.html">') && !/<script/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'unexpected html');
  return `${rel(t.savedPath)} (${html.length} chars)`;
});

await test('settings: global speed limit', async () => {
  await ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, speedLimitKB: 4096 } });
  });
  await sleep(500);
  const id = await add({ url: `${SERVER}/files/fast.bin`, filename: 'limited.bin' });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 1e6, 20000);
  const a = (await send('listTasks')).tasks.find((x) => x.id === id);
  await sleep(4000);
  const b = (await send('listTasks')).tasks.find((x) => x.id === id);
  const speed = (b.received - a.received) / 4 / 1024 / 1024;
  await send('taskAction', { action: 'remove', ids: [id] });
  await ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, speedLimitKB: 0 } });
  });
  assert(speed > 2.8 && speed < 5.2, `speed ${speed.toFixed(2)} MB/s not near 4 MB/s`);
  return `${speed.toFixed(2)} MB/s with 4 MB/s limit`;
});

await test('http: raw throughput (unthrottled 64 MB)', async () => {
  const t0 = Date.now();
  const id = await add({ url: `${SERVER}/files/fast.bin`, filename: 'throughput.bin' });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const secs = (Date.now() - t0) / 1000;
  return `${(64 / secs).toFixed(0)} MB/s end-to-end (download + assemble + save), ${secs.toFixed(1)}s`;
});

await test('hls: pause & resume mid-download', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls-slow/ts/master.m3u8`, filename: 'hls暂停续传.mp4' });
  const p0 = await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 1.2e6, 30000);
  await send('taskAction', { action: 'pause', ids: [id] });
  const p = await waitTask(send, id, (t) => t.state === 'paused', 15000);
  await sleep(500);
  await send('taskAction', { action: 'resume', ids: [id] });
  const t = await waitTask(send, id);
  void p0;
  return `paused at ${(p.received / 1e6).toFixed(2)}MB → ` + (await checkVideo(t));
});

await test('merge: pause & resume separate tracks', async () => {
  const id = await add({
    type: 'merge', url: `${SERVER}/dash-slow/video.m4s`, filename: '合并暂停续传.mp4', referer: `${SERVER}/page.html`,
    parts: [{ url: `${SERVER}/dash-slow/video.m4s`, role: 'video' }, { url: `${SERVER}/dash-slow/audio.m4s`, role: 'audio' }],
  });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 2e6, 30000);
  await send('taskAction', { action: 'pause', ids: [id] });
  const p = await waitTask(send, id, (t) => t.state === 'paused', 15000);
  await send('taskAction', { action: 'resume', ids: [id] });
  const t = await waitTask(send, id);
  return `paused at ${(p.received / 1e6).toFixed(2)}MB → ` + (await checkVideo(t, { minDur: 23.9, maxDur: 24.2 }));
});

await test('merge: progressive MP4 inputs (moov at end)', async () => {
  const id = await add({
    type: 'merge', url: `${SERVER}/dash/prog_video.mp4`, filename: '普通MP4合并.mp4',
    parts: [{ url: `${SERVER}/dash/prog_video.mp4`, role: 'video' }, { url: `${SERVER}/dash/prog_audio_moovend.m4a`, role: 'audio' }],
  });
  return checkVideo(await waitTask(send, id), { minDur: 23.9, maxDur: 24.1 });
});

await test('takeover: name only from Content-Disposition (download.php)', async () => {
  await page.click('#php');
  let task = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const { tasks } = await send('listTasks');
    task = tasks.find((x) => x.source === 'takeover' && x.url.includes('download.php'));
    if (task) break;
    await sleep(300);
  }
  assert(task, 'no takeover task');
  const t = await waitTask(send, task.id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  assert(t.savedPath.endsWith('年度报告.pdf'), 'unexpected name ' + t.savedPath);
  return rel(t.savedPath);
});

await test('ui: every page loads without script errors', async () => {
  const errors = [];
  for (const u of ['popup.html?tabId=' + tabId, 'manager.html', 'options.html']) {
    const pg = await browser.newPage();
    pg.on('pageerror', (e) => errors.push(`${u}: ${e.message}`));
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(`${u}: ${m.text()}`); });
    await pg.goto(`chrome-extension://${extId}/ui/${u}`);
    await sleep(1500);
    await pg.close();
  }
  await send('grabLinks', { tabId });
  const gt = await browser.waitForTarget((t) => t.url().includes('/ui/grab.html'), { timeout: 10000 });
  const gp = await gt.page();
  gp.on('pageerror', (e) => errors.push(`grab: ${e.message}`));
  await sleep(1200);
  const rowsN = await gp.$$eval('#rows tr', (r) => r.length);
  await gp.close();
  assert(!errors.length, errors.join('\n'));
  assert(rowsN >= 8, 'grab rows ' + rowsN);
  return `popup, manager, options, grab (${rowsN} links) OK`;
});

await test('hls: resolution change mid-stream falls back to TS', async () => {
  const id = await add({ type: 'hls', url: `${SERVER}/hls/ts/mixed.m3u8`, filename: '中途换分辨率.mp4' });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(t.savedPath.endsWith('.ts'), 'expected TS fallback, got ' + t.savedPath);
  const ok = decodeOk(t.savedPath);
  assert(ok === true, 'decode errors: ' + ok);
  // the note must be a readable explanation, not a leaked JavaScript error
  assert(t.note && !/initialization|is not a function|undefined|^\w+$/.test(t.note), 'unexpected note: ' + t.note);
  return `${rel(t.savedPath)} note=${t.note}`;
});

await test('settings: very low speed limit does not trip the stall watchdog', async () => {
  await ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, speedLimitKB: 24 } });
  });
  await sleep(500);
  await serverLog(true);
  const id = await add({ url: `${SERVER}/files/fast.bin?low=1`, filename: 'lowlimit.bin' });
  await sleep(24000);
  const t = (await send('listTasks')).tasks.find((x) => x.id === id);
  const reqs = (await serverLog()).filter((x) => x.url.startsWith('/files/fast.bin')).length;
  await send('taskAction', { action: 'remove', ids: [id] });
  await ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, speedLimitKB: 0 } });
  });
  assert(t.state === 'downloading', 'state ' + t.state + ' ' + t.error);
  assert(reqs <= 7, `connections were re-opened ${reqs} times (stall watchdog tripped)`);
  assert(t.received > 300 * 1024 && t.received < 900 * 1024, `received ${t.received} bytes, expected about 24 KB/s × 24 s`);
  return `${(t.received / 1024).toFixed(0)} KB in 24s at 24 KB/s limit, ${reqs} requests`;
});

await test('security: content scripts cannot call privileged commands', async () => {
  const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
  const res = await ext.evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async () => {
        const out = {};
        out.list = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'listTasks' }).catch((e) => ({ thrown: String(e) }));
        out.save = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'save', url: 'https://example.com/x', filename: 'x' }).catch((e) => ({ thrown: String(e) }));
        out.engine = await chrome.runtime.sendMessage({ to: 'engine', cmd: 'list' }).catch((e) => ({ thrown: String(e) }));
        out.media = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'mediaCount', tabId: 123456 }).catch((e) => ({ thrown: String(e) }));
        return out;
      },
    });
    return r.result;
  }, pageTab);
  assert(res.list?.error, 'listTasks allowed: ' + JSON.stringify(res.list).slice(0, 80));
  assert(res.save?.error, 'save allowed');
  assert(!res.engine?.tasks, 'engine answered a content script');
  assert(typeof res.media?.count === 'number', 'mediaCount should work: ' + JSON.stringify(res.media));
  return `listTasks → ${res.list.error}; engine → ${String(JSON.stringify(res.engine))}; mediaCount → ${res.media.count}`;
});

await test('takeover: resumes a paused duplicate instead of losing the download', async () => {
  const url = `${SERVER}/download/report.zip`;
  const id = await add({ url, filename: '重复接管.zip' });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 4e6, 20000);
  await send('taskAction', { action: 'pause', ids: [id] });
  await waitTask(send, id, (t) => t.state === 'paused', 15000);
  await page.click('#zip');
  const t = await waitTask(send, id, undefined, 60000);
  assert(t.state === 'completed', 'paused duplicate was not resumed: ' + t.state);
  const same = (await send('listTasks')).tasks.filter((x) => x.url === url && x.createdAt >= t.createdAt);
  assert(same.length === 1, 'duplicate tasks: ' + same.length);
  await sleep(500);
  const leftovers = await ext.evaluate(async () => (await chrome.downloads.search({ urlRegex: 'report\\.zip', state: 'in_progress' })).length);
  assert(leftovers === 0, 'browser download still running');
  return `resumed task ${rel(t.savedPath)}`;
});

await test('update: re-injected overlay replaces an orphaned instance and never duplicates a live one', async () => {
  const pageTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8080/page.html' }))[0]?.id);
  const run = (func) => ext.evaluate(async (tabId, src) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: new Function(`return (${src})()`) });
    return r.result;
  }, pageTab, func.toString());
  const inject = () => ext.evaluate(async (tabId) => { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] }); }, pageTab);
  // 1) Injecting again while an instance is alive must not create a second one
  await run(() => { window.__probeToken = window.__shuttleDM; return true; });
  await inject();
  const same = await run(() => window.__shuttleDM === window.__probeToken && window.__shuttleDM.alive());
  assert(same === true, 'live instance was replaced or duplicated');
  // 2) Simulate the orphaned instance left behind by an update: the new script should remove it and take over
  await run(() => { window.__destroyed = false; window.__shuttleDM = { alive: () => false, destroy: () => { window.__destroyed = true; } }; return true; });
  await inject();
  const res = await run(() => ({ destroyed: window.__destroyed, alive: !!window.__shuttleDM?.alive?.() }));
  assert(res.destroyed && res.alive, 'orphaned instance not replaced: ' + JSON.stringify(res));
  return 'live instance kept, orphaned instance replaced';
});

await test('persistence: resume after browser restart', async () => {
  const id = await add({ url: `${SERVER}/files/slow.bin`, filename: 'restart.bin' });
  await waitTask(send, id, (t) => t.state === 'downloading' && t.received > 10e6, 30000);
  await send('taskAction', { action: 'pause', ids: [id] });
  const p = await waitTask(send, id, (t) => t.state === 'paused', 15000);
  await browser.close();
  await sleep(1000);
  ctx = await launch(PROFILE, { fresh: false });
  ({ browser, send, ext, extId } = ctx);
  const listed = (await send('listTasks')).tasks.find((x) => x.id === id);
  assert(listed && listed.state === 'paused' && listed.received > 0, 'task not restored: ' + JSON.stringify(listed && { state: listed.state, received: listed.received }));
  await serverLog(true);
  await send('taskAction', { action: 'resume', ids: [id] });
  const t = await waitTask(send, id);
  assert(t.state === 'completed', t.error);
  assert(sha256(t.savedPath) === BIG_SHA, 'sha mismatch');
  const first = (await serverLog()).find((x) => x.url === '/files/slow.bin');
  assert(first.start > 0, 'restarted from 0');
  return `paused at ${(p.received / 1e6).toFixed(1)}MB → restored ${(listed.received / 1e6).toFixed(1)}MB → first range ${first.range}`;
});

await browser.close();
console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(48)} ${String(r.secs).padStart(5)}s  ${r.detail}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
fs.writeFileSync(path.join(WORK, 'e2e-results.json'), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
