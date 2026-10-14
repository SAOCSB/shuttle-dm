// Download engine (runs in the offscreen document): task queue, scheduling, progress broadcasts, storage and saving.

import { db } from '../common/db.js';
import { DEFAULT_SETTINGS, clampSettings } from '../common/settings.js';
import {
  uid, sanitizeFilename, sanitizeSubpath, filenameFromUrl, ensureExt, extOf, categoryOf, categoryFolder,
  replaceExt, stripExt, isAbortError, HLS_MIMES, sleep,
} from '../common/util.js';
import { Mp4Muxer, readInitFromBlob } from '../common/mp4.js';
import { HttpJob, buildBlobFromPieces } from './http.js';
import { HlsJob, buildHlsOutput } from './hls.js';
import { Limiter } from './limiter.js';
import { taskDir, removeTaskDir, listTaskDirs } from './opfs.js';
import { i18n, initI18n } from '../common/i18n.js';

const muxjs = globalThis.muxjs;
const bc = new BroadcastChannel('shuttle-dm');
const tasks = new Map();
const runs = new Map();
const dirty = new Set();
const pendingBlobs = new Map();
const limiter = new Limiter(0);
let settings = clampSettings({ ...DEFAULT_SETTINGS });

class SwitchToHls extends Error {}
class TakeoverRejected extends Error {}
const takeoverWaiters = new Map();

function decideTakeover(t, accepted) {
  if (!t.takeover || t.takeover.decided) return;
  t.takeover.decided = true;
  t.takeover.accepted = accepted;
  const w = takeoverWaiters.get(t.id);
  takeoverWaiters.delete(t.id);
  w?.({ ids: [t.id], accepted });
}

// Must be registered synchronously so the first message isn't missed
let idleSince = Date.now();

const EXT_ORIGIN = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'engine') return false;
  // Only accept commands from the extension's own pages and background; content scripts can't drive the engine
  if (!sender?.url?.startsWith(EXT_ORIGIN)) return false;
  idleSince = Date.now();
  ready
    .then(() => handle(msg))
    .then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

const ready = init();

async function bg(cmd, data = {}) {
  const r = await chrome.runtime.sendMessage({ to: 'bg', cmd, ...data });
  if (r && r.error) throw new Error(r.error);
  return r;
}

function applySettings(s) {
  settings = clampSettings({ ...DEFAULT_SETTINGS, ...(s || {}) });
  limiter.setRate(settings.speedLimitKB * 1024);
}

async function init() {
  // Offscreen documents can't use chrome.i18n: ask the background for the UI language and load the messages
  try {
    await initI18n((await bg('uiLanguage')).lang);
  } catch (e) {
    console.warn('[engine] i18n', e);
    await initI18n(navigator.language).catch(() => {});
  }
  try {
    applySettings(await bg('getSettings'));
  } catch (e) {
    console.warn('[engine] settings', e);
  }
  const all = await db.getAll('tasks');
  for (const t of all) {
    if (['downloading', 'merging', 'saving'].includes(t.state)) {
      if (t.type === 'blob') {
        t.state = 'error';
        t.error = i18n('errBlobLostRestart');
      } else {
        t.state = 'paused';
      }
      dirty.add(t.id);
    }
    tasks.set(t.id, t);
  }
  const keep = new Set(all.filter((t) => t.state !== 'completed').map((t) => t.id));
  for (const d of await listTaskDirs()) if (!keep.has(d)) await removeTaskDir(d);
  setInterval(tick, 500);
  setInterval(persistDirty, 2000);
  // Close the engine document after 5 idle minutes to free memory; it starts again when needed
  setInterval(() => {
    if (runs.size || pendingBlobs.size) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince > 5 * 60 * 1000) {
      idleSince = Date.now();
      persistDirty().then(() => bg('closeEngine')).catch(() => {});
    }
  }, 30000);
  pump();
}

// ---------- Messages ----------

async function handle(msg) {
  switch (msg.cmd) {
    case 'ping':
      return { ok: true };
    case 'settings':
      applySettings(msg.settings);
      pump();
      return { ok: true };
    case 'add':
      return addTasks(msg.tasks || [msg.task]);
    case 'list':
      return { tasks: [...tasks.values()].map(summary) };
    case 'get':
      return { task: tasks.has(msg.id) ? summary(tasks.get(msg.id)) : null };
    case 'action':
      return action(msg.action, msg.ids || [], msg);
    case 'importBlob':
      return importBlob(msg);
    default:
      throw new Error(i18n('errUnknownCommand', msg.cmd));
  }
}

function guessType(p) {
  if (p.type) return p.type;
  if (p.parts?.length) return 'merge';
  try {
    if (/\.m3u8?$/i.test(new URL(p.url).pathname)) return 'hls';
  } catch { /* ignore */ }
  return 'http';
}

function defaultName(p, type) {
  const title = sanitizeFilename(p.pageTitle || '', '');
  if (type === 'hls' || type === 'merge') return `${title || stripExt(filenameFromUrl(p.url)) || 'video'}.mp4`;
  return sanitizeFilename(filenameFromUrl(p.url) || title || 'download');
}

function addTasks(list) {
  const ids = [];
  const duplicates = [];
  let waiter = null;
  for (const p of list) {
    if (!p || !p.url) continue;
    if (!/^https?:/i.test(p.url)) throw new Error(i18n('errHttpOnly'));
    const dup = [...tasks.values()].find(
      (t) => t.url === p.url && (t.hls?.variantUri || null) === (p.variant || null) && !['completed', 'error'].includes(t.state),
    );
    if (dup && p.takeover) {
      // There is already an unfinished task for this link: resume it and take over this browser download
      if (dup.state === 'paused') {
        dup.state = 'queued';
        dup.error = null;
        emitTask(dup);
        dirty.add(dup.id);
        persistDirty();
        pump();
      }
      return { ids: [dup.id], duplicates: [dup.id], accepted: true };
    }
    if (dup) {
      duplicates.push(dup.id);
      if (dup.state === 'paused') {
        dup.state = 'queued';
        emitTask(dup);
        dirty.add(dup.id);
      }
      continue;
    }
    const type = guessType(p);
    const fixed = p.filename ? sanitizeFilename(p.filename) : '';
    const t = {
      id: uid(),
      type,
      url: p.url,
      referer: p.referer || '',
      pageUrl: p.pageUrl || '',
      pageTitle: p.pageTitle || '',
      filename: fixed || defaultName(p, type),
      filenameFixed: !!fixed,
      dir: p.dir ? sanitizeSubpath(p.dir) : '',
      mime: p.mime || '',
      size: p.size || null,
      received: 0,
      state: 'queued',
      error: null,
      note: null,
      createdAt: Date.now() + ids.length, // keep the order of a batch
      completedAt: null,
      threads: p.threads ? Math.max(1, Math.min(32, p.threads | 0)) : null,
      resumable: null,
      downloadId: null,
      savedPath: null,
      http: null,
      hls: type === 'hls'
        ? {
          variantUri: p.variant || null, variantInfo: p.variantInfo || null, audioUri: p.audio || null,
          quality: p.quality || '', format: p.format || null, live: false, noAudio: !!p.noAudio,
        }
        : null,
      parts: type === 'merge'
        ? p.parts.map((x, i) => ({ url: x.url, role: x.role || (i === 0 ? 'video' : 'audio'), size: x.size || null, info: null }))
        : null,
      source: p.source || '',
    };
    if (type === 'hls' && !extOf(t.filename)) t.filename += '.mp4';
    tasks.set(t.id, t);
    ids.push(t.id);
    if (p.takeover && type === 'http') {
      // Browser takeover: start right away (no queue); the takeover is confirmed once the first response checks out
      t.takeover = { ...p.takeover, decided: false };
      t.forceFile = true;
      waiter = new Promise((resolve) => takeoverWaiters.set(t.id, resolve));
      setTimeout(() => {
        if (!t.takeover.decided) {
          runs.get(t.id)?.ac.abort(new DOMException('removed', 'AbortError'));
          decideTakeover(t, false);
          removeSilently(t.id);
        }
      }, 15000);
      start(t);
    } else {
      emitTask(t);
      dirty.add(t.id);
    }
  }
  persistDirty();
  pump();
  return waiter || { ids, duplicates };
}

async function removeSilently(id) {
  tasks.delete(id);
  dirty.delete(id);
  await removeTaskDir(id);
  persisting = persisting.then(() => db.delete('tasks', id)).catch(() => {});
  bc.postMessage({ type: 'removed', id });
}

async function action(kind, ids, opts) {
  if (kind === 'pauseAll') ids = [...tasks.values()].filter((t) => ['queued', 'downloading'].includes(t.state)).map((t) => t.id);
  if (kind === 'resumeAll') ids = [...tasks.values()].filter((t) => ['paused', 'error'].includes(t.state)).map((t) => t.id);
  if (kind === 'clearCompleted') ids = [...tasks.values()].filter((t) => t.state === 'completed').map((t) => t.id);
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) continue;
    const rt = runs.get(id);
    switch (kind) {
      case 'pause':
      case 'pauseAll':
        if (rt) {
          if (t.hls?.live && rt.job?.stop) rt.job.stop();
          else if (t.state === 'downloading') rt.ac.abort(new DOMException('paused', 'AbortError'));
        } else if (t.state === 'queued') {
          t.state = 'paused';
          emitTask(t);
          dirty.add(id);
        }
        break;
      case 'stop':
        if (rt?.job?.stop) rt.job.stop();
        break;
      case 'resume':
      case 'resumeAll':
        if (!rt && ['paused', 'error'].includes(t.state)) {
          t.state = 'queued';
          t.error = null;
          emitTask(t);
          dirty.add(id);
        }
        break;
      case 'redownload':
        if (t.type === 'blob') throw new Error(i18n('errBlobNoRedownload'));
        if (rt) {
          rt.ac.abort(new DOMException('removed', 'AbortError'));
          await rt.promise;
        }
        await removeTaskDir(id);
        Object.assign(t, { state: 'queued', error: null, note: null, received: 0, http: null, resumable: null, downloadId: null, savedPath: null, completedAt: null, createdAt: Date.now() });
        if (t.hls) Object.assign(t.hls, { live: false });
        if (t.parts) t.parts.forEach((p) => { p.info = null; });
        emitTask(t);
        dirty.add(id);
        break;
      case 'remove':
      case 'clearCompleted':
        if (rt) {
          rt.ac.abort(new DOMException('removed', 'AbortError'));
          try { await rt.promise; } catch { /* ignore */ }
        }
        tasks.delete(id);
        dirty.delete(id);
        pendingBlobs.delete(id);
        await removeTaskDir(id);
        // Serialize with the persistence queue so a later write can't bring it back
        persisting = persisting.then(() => db.delete('tasks', id)).catch((e) => console.warn('[engine] delete', e));
        await persisting;
        if (opts.deleteFile && t.downloadId != null) {
          try { await bg('removeFile', { id: t.downloadId }); } catch (e) { console.warn(e); }
        }
        bc.postMessage({ type: 'removed', id });
        break;
      case 'rename':
        if (opts.filename && t.state !== 'completed') {
          t.filename = sanitizeFilename(opts.filename);
          t.filenameFixed = true;
          emitTask(t);
          dirty.add(id);
        }
        break;
      default:
        throw new Error(i18n('errUnknownAction', kind));
    }
  }
  await persistDirty();
  pump();
  return { ok: true };
}

async function importBlob(msg) {
  const rec = await db.get('blobs', msg.key);
  if (!rec?.blob) throw new Error(i18n('errDataMissing'));
  await db.delete('blobs', msg.key);
  const blob = msg.mime && rec.blob.type !== msg.mime ? new Blob([rec.blob], { type: msg.mime }) : rec.blob;
  const t = {
    id: uid(),
    type: 'blob',
    url: msg.sourceUrl || '',
    referer: '',
    pageUrl: msg.sourceUrl || '',
    pageTitle: msg.title || '',
    filename: sanitizeFilename(msg.filename || 'page.html'),
    filenameFixed: true,
    dir: msg.dir ? sanitizeSubpath(msg.dir) : '',
    mime: blob.type || msg.mime || '',
    size: blob.size,
    received: blob.size,
    state: 'queued',
    error: null,
    note: null,
    createdAt: Date.now(),
    completedAt: null,
    downloadId: null,
    savedPath: null,
    source: msg.source || 'page',
  };
  tasks.set(t.id, t);
  pendingBlobs.set(t.id, blob);
  start(t);
  return { ids: [t.id] };
}

// ---------- Scheduling ----------

function pump() {
  let active = 0;
  for (const [id] of runs) if (tasks.get(id)?.type !== 'blob') active++;
  let slots = settings.maxConcurrent - active;
  if (slots <= 0) return;
  const queued = [...tasks.values()].filter((t) => t.state === 'queued' && !runs.has(t.id)).sort((a, b) => a.createdAt - b.createdAt);
  for (const t of queued) {
    if (slots-- <= 0) break;
    start(t);
  }
}

function start(t) {
  const rt = {
    ac: new AbortController(),
    job: null,
    jobs: null,
    speed: 0,
    lastBytes: t.received || 0,
    lastTime: performance.now(),
    hosts: new Set(),
    mergeProgress: null,
  };
  runs.set(t.id, rt);
  t.state = t.type === 'blob' ? 'saving' : 'downloading';
  t.error = null;
  emitTask(t);
  dirty.add(t.id);
  rt.promise = (async () => {
    try {
      await runTask(t, rt);
      t.state = 'completed';
      t.completedAt = Date.now();
      if (t.size == null) t.size = t.received;
      t.received = t.size;
      if (settings.notify && t.type !== 'blob' && t.source !== 'grab') bg('notify', { taskId: t.id, kind: 'done', message: t.filename }).catch(() => {});
    } catch (e) {
      if (t.takeover && !t.takeover.decided) {
        // Takeover failed (e.g. the link can't be requested again): give it back to the browser
        decideTakeover(t, false);
        await removeSilently(t.id);
        return;
      }
      const reason = rt.ac.signal.aborted ? rt.ac.signal.reason?.message : null;
      if (reason === 'removed') return;
      if (rt.ac.signal.aborted || isAbortError(e)) {
        t.state = 'paused';
      } else {
        console.error('[engine] task failed', t.id, e);
        t.state = 'error';
        t.error = friendlyError(e);
        if (settings.notify && t.source !== 'grab') bg('notify', { taskId: t.id, kind: 'error', message: `${t.filename}\n${t.error}` }).catch(() => {});
      }
    } finally {
      runs.delete(t.id);
      if (tasks.has(t.id)) {
        emitTask(t);
        dirty.add(t.id);
        await persistDirty();
      }
      pump();
    }
  })();
}

function friendlyError(e) {
  const name = e?.name || '';
  const msg = String(e?.message || e);
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return i18n('errDiskFull');
  if (name === 'NotReadableError' || name === 'InvalidStateError') return i18n('errTempIo', msg);
  if (/Failed to fetch|NetworkError|network error/i.test(msg)) return i18n('errNetwork');
  return msg;
}

async function runTask(t, rt) {
  if (t.type === 'blob') {
    const blob = pendingBlobs.get(t.id);
    if (!blob) throw new Error(i18n('errDataLost'));
    await saveBlob(t, rt, blob);
    pendingBlobs.delete(t.id);
    return;
  }
  if (t.type === 'hls') return runHls(t, rt);
  if (t.type === 'merge') return runMerge(t, rt);
  try {
    return await runHttp(t, rt);
  } catch (e) {
    if (!(e instanceof SwitchToHls)) throw e;
    // The link is actually an M3U8 playlist: switch to an HLS task
    await removeTaskDir(t.id);
    t.type = 'hls';
    t.http = null;
    t.size = null;
    t.received = 0;
    t.hls = { variantUri: null, audioUri: null, quality: '', format: null, live: false };
    t.filename = `${stripExt(t.filenameFixed ? t.filename : (sanitizeFilename(t.pageTitle, '') || stripExt(t.filename) || 'video'))}.mp4`;
    emitTask(t);
    return runHls(t, rt);
  }
}

async function beforeFetch(t, rt, url) {
  if (!t.referer) return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  if (rt.hosts.has(host)) return;
  rt.hosts.add(host);
  try {
    await bg('headers', { url, referer: t.referer });
  } catch (e) {
    console.warn('[engine] header rule', e);
  }
}

async function runHttp(t, rt) {
  const dir = await taskDir(t.id);
  const job = new HttpJob({
    url: t.url,
    dir,
    threads: t.threads || settings.threads,
    retries: settings.retries,
    limiter,
    signal: rt.ac.signal,
    info: t.http,
    beforeFetch: (u) => beforeFetch(t, rt, u),
    onInfo: (info) => {
      if (t.takeover && !t.takeover.decided) {
        const tk = t.takeover;
        const htmlExpected = ['htm', 'html', 'mhtml', 'shtml'].includes(tk.expectExt);
        if (info.mime === 'text/html' && !htmlExpected) throw new TakeoverRejected(i18n('takeoverGotHtml'));
        if (tk.expectSize && info.size != null && info.size !== tk.expectSize) throw new TakeoverRejected(i18n('takeoverSizeMismatch'));
        decideTakeover(t, true);
        emitTask(t);
      }
      if (HLS_MIMES.has(info.mime) && !t.forceFile && (info.size == null || info.size < 8e6)) throw new SwitchToHls();
      t.http = { size: info.size, resumable: info.resumable, etag: info.etag, lastModified: info.lastModified, mime: info.mime, finalUrl: info.finalUrl };
      t.size = info.size;
      t.resumable = info.resumable;
      if (info.mime && info.mime !== 'application/octet-stream') t.mime = info.mime;
      if (!t.filenameFixed) {
        const name = info.filename || filenameFromUrl(info.finalUrl || t.url) || t.filename;
        t.filename = ensureExt(sanitizeFilename(name), info.mime);
      } else if (!extOf(t.filename)) {
        t.filename = ensureExt(t.filename, info.mime);
      }
      emitTask(t);
      dirty.add(t.id);
    },
  });
  rt.job = job;
  await job.run();
  t.size = job.size;
  t.received = job.size;
  const blob = await buildBlobFromPieces(dir, job.size, t.mime);
  await saveBlob(t, rt, blob);
}

async function runHls(t, rt) {
  const root = await taskDir(t.id);
  const dirs = { root, main: await taskDir(t.id, 'main'), audio: await taskDir(t.id, 'audio') };
  const job = new HlsJob({
    task: t,
    dirs,
    concurrency: settings.hlsConcurrency,
    retries: settings.retries,
    limiter,
    signal: rt.ac.signal,
    beforeFetch: (u) => beforeFetch(t, rt, u),
    onChange: () => {
      emitTask(t);
      dirty.add(t.id);
    },
  });
  rt.job = job;
  await job.run();
  t.state = 'merging';
  emitTask(t);
  const out = await buildHlsOutput({
    tracks: job.tracks,
    format: t.hls.format || settings.hlsFormat,
    muxjs,
    signal: rt.ac.signal,
    onProgress: (p) => { rt.mergeProgress = p; },
  });
  t.note = [job.note, out.note].filter(Boolean).join(i18n('noteSeparator')) || null;
  t.filename = replaceExt(t.filename, out.ext);
  t.mime = out.mime;
  t.size = out.blob.size;
  t.received = out.blob.size;
  await saveBlob(t, rt, out.blob);
}

async function runMerge(t, rt) {
  const total = t.parts.length;
  const share = Math.max(1, Math.floor((t.threads || settings.threads) / total));
  const jobs = [];
  const blobs = new Array(total);
  const local = new AbortController();
  const onAbort = () => local.abort(rt.ac.signal.reason);
  rt.ac.signal.addEventListener('abort', onAbort, { once: true });
  rt.jobs = jobs;
  try {
    await Promise.all(t.parts.map(async (part, i) => {
      const dir = await taskDir(t.id, 'part' + i);
      const job = new HttpJob({
        url: part.url,
        dir,
        threads: part.role === 'audio' ? Math.min(4, share) : Math.max(share, (t.threads || settings.threads) - 2),
        retries: settings.retries,
        limiter,
        signal: local.signal,
        info: part.info,
        beforeFetch: (u) => beforeFetch(t, rt, u),
        onInfo: (info) => {
          part.info = { size: info.size, resumable: info.resumable, etag: info.etag, mime: info.mime };
          part.size = info.size;
          dirty.add(t.id);
        },
      });
      jobs[i] = job;
      try {
        await job.run();
      } catch (e) {
        if (!local.signal.aborted) local.abort(e);
        throw e;
      }
      part.size = job.size;
      blobs[i] = await buildBlobFromPieces(dir, job.size);
    }));
  } finally {
    rt.ac.signal.removeEventListener('abort', onAbort);
  }
  t.state = 'merging';
  emitTask(t);
  const muxer = new Mp4Muxer();
  for (let i = 0; i < total; i++) {
    const role = t.parts[i].role;
    const init = await readInitFromBlob(blobs[i]);
    const input = muxer.addInput(init, { only: role === 'audio' ? 'soun' : role === 'video' ? 'vide' : null });
    const src = muxer.addSource(blobs[i]);
    if (input.init.fragmented) await muxer.addFragmentsFromBlob(input, blobs[i], src, rt.ac.signal);
    else muxer.addProgressive(input, src);
    rt.mergeProgress = (i + 1) / total;
  }
  const kinds = muxer.summary();
  const hasVideo = kinds.some((k) => k.type === 'video');
  const { blob } = muxer.build(hasVideo ? 'video/mp4' : 'audio/mp4');
  t.filename = replaceExt(t.filename, hasVideo ? 'mp4' : 'm4a');
  t.mime = hasVideo ? 'video/mp4' : 'audio/mp4';
  t.size = blob.size;
  t.received = blob.size;
  await saveBlob(t, rt, blob);
}

function savePath(t) {
  const parts = [];
  const sub = sanitizeSubpath(settings.subfolder);
  if (sub) parts.push(sub);
  if (t.dir) parts.push(t.dir);
  else if (settings.categorize) parts.push(categoryFolder(categoryOf(t.filename, t.mime)));
  parts.push(sanitizeFilename(t.filename));
  return parts.join('/');
}

async function saveBlob(t, rt, blob) {
  t.state = 'saving';
  emitTask(t);
  dirty.add(t.id);
  const url = URL.createObjectURL(blob);
  try {
    const res = await bg('save', { url, filename: savePath(t), taskId: t.id });
    t.downloadId = res.downloadId;
    dirty.add(t.id);
    for (;;) {
      await sleep(500);
      if (rt.ac.signal.aborted) {
        bg('cancelDownload', { id: t.downloadId }).catch(() => {});
        throw rt.ac.signal.reason;
      }
      const st = await bg('dlState', { id: t.downloadId });
      if (st.state === 'complete') {
        t.savedPath = st.filename || null;
        if (st.fileSize > 0) t.size = st.fileSize;
        break;
      }
      if (st.state === 'interrupted' || st.missing) {
        throw new Error(i18n('errSaveFailed', st.error || i18n('downloadItemLost')));
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  await removeTaskDir(t.id);
}

// ---------- Progress ----------

function currentReceived(t, rt) {
  if (rt.jobs?.length) return rt.jobs.reduce((a, j) => a + (j?.received || 0), 0);
  if (rt.job) return rt.job.received;
  return t.received || 0;
}

function currentSize(t, rt) {
  if (rt.jobs?.length) {
    if (rt.jobs.length < t.parts.length || rt.jobs.some((j) => !j || j.size == null)) return null;
    return rt.jobs.reduce((a, j) => a + j.size, 0);
  }
  if (t.type === 'hls' && rt.job?.stats) {
    const st = rt.job.stats();
    if (rt.job.live || !st.done) return null;
    return Math.round((rt.job.received / Math.max(1, st.done)) * st.total);
  }
  return rt.job?.size ?? t.size ?? null;
}

function tick() {
  if (!runs.size) return;
  const now = performance.now();
  const items = [];
  for (const [id, rt] of runs) {
    const t = tasks.get(id);
    if (!t) continue;
    const received = t.state === 'downloading' ? currentReceived(t, rt) : t.received;
    const dt = (now - rt.lastTime) / 1000;
    if (dt > 0.2) {
      const inst = Math.max(0, (received - rt.lastBytes) / dt);
      rt.speed = rt.speed ? rt.speed * 0.55 + inst * 0.45 : inst;
      rt.lastBytes = received;
      rt.lastTime = now;
    }
    const speed = t.state === 'downloading' ? rt.speed : 0;
    if (t.state === 'downloading') {
      t.received = received;
      const size = currentSize(t, rt);
      if (size) t.size = size;
      dirty.add(id);
    }
    const remaining = t.size ? Math.max(0, t.size - t.received) : null;
    let hls = null;
    if (t.type === 'hls' && rt.job?.stats) {
      const st = rt.job.stats();
      hls = { total: st.total, done: st.done, duration: st.duration, doneDuration: st.doneDuration, live: rt.job.live };
    }
    items.push({
      id,
      state: t.state,
      received: t.received,
      size: t.size,
      speed,
      eta: speed > 1 && remaining != null ? remaining / speed : null,
      map: t.state === 'downloading' && rt.job?.map ? rt.job.map(100) : null,
      conns: t.state === 'downloading' && rt.job?.connections ? rt.job.connections() : null,
      parts: rt.jobs ? rt.jobs.map((j) => (j ? { received: j.received, size: j.size } : null)) : null,
      hls,
      merge: t.state === 'merging' ? rt.mergeProgress : null,
    });
  }
  bc.postMessage({ type: 'progress', items });
}

function summary(t) {
  const rt = runs.get(t.id);
  return { ...t, running: !!rt, speed: rt && t.state === 'downloading' ? rt.speed : 0 };
}

function emitTask(t) {
  bc.postMessage({ type: 'task', task: summary(t) });
}

let persisting = Promise.resolve();
function persistDirty() {
  if (!dirty.size) return persisting;
  const items = [...dirty].map((id) => tasks.get(id)).filter(Boolean).map((t) => ({ ...t }));
  dirty.clear();
  persisting = persisting.then(() => db.putMany('tasks', items)).catch((e) => console.warn('[engine] persist', e));
  return persisting;
}
