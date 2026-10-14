// Media detection: watches network requests and records the video, audio and HLS streams seen on each tab.

import { classifyResponse, mediaKey, isMp4Family } from '../common/media.js';
import { parseM3U8, encryptionOf } from '../common/m3u8.js';
import { probeInitBytes } from '../common/mp4.js';
import { uid } from '../common/util.js';
import { isVideoBlockedUrl } from '../common/sites.js';
import { ensureHeaderRule } from './headers.js';

const TYPES = ['media', 'xmlhttprequest', 'other', 'object', 'main_frame', 'sub_frame'];
const MAX_ITEMS = 80;
const refs = new Map();
const store = new Map();
const persistTimers = new Map();
const enriching = new Map();
let minBytes = 200 * 1024;

export function setSniffMinKB(kb) {
  minBytes = Math.max(0, Number(kb) || 0) * 1024;
}

export function initSniffer() {
  chrome.webRequest.onSendHeaders.addListener(onSend, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onResponseStarted.addListener(onResponse, { urls: ['<all_urls>'], types: TYPES }, ['responseHeaders']);
  chrome.webRequest.onErrorOccurred.addListener((d) => refs.delete(d.requestId), { urls: ['<all_urls>'], types: TYPES });
  chrome.tabs.onRemoved.addListener((tabId) => {
    store.delete(tabId);
    chrome.storage.session.remove('media:' + tabId).catch(() => {});
  });
}

function onSend(d) {
  if (d.tabId < 0) return;
  for (const h of d.requestHeaders || []) {
    if (h.name.toLowerCase() === 'referer') {
      refs.set(d.requestId, h.value);
      if (refs.size > 2000) refs.delete(refs.keys().next().value);
      return;
    }
  }
}

function onResponse(d) {
  if (d.tabId < 0) return;
  const referer = refs.get(d.requestId);
  refs.delete(d.requestId);
  if (d.type === 'main_frame') {
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
    if (/text\/html|application\/xhtml/i.test(ct) || d.statusCode >= 300) {
      resetTab(d.tabId, d.url);
      return;
    }
  }
  // Skip unsupported sites (see common/sites.js), including their players embedded in other pages
  if (isVideoBlockedUrl(d.url) || isVideoBlockedUrl(d.initiator)) return;
  const c = classifyResponse(d, minBytes);
  if (!c) return;
  addItem(d.tabId, { ...c, url: d.url, referer: referer ?? null, frameId: d.frameId, reqType: d.type, time: Date.now() }).catch((e) =>
    console.warn('[sniffer] add', e),
  );
}

export function getTabData(tabId) {
  if (!store.has(tabId)) {
    const key = 'media:' + tabId;
    store.set(tabId, chrome.storage.session.get(key).then((r) => r[key] || { items: [], pageUrl: '' }).catch(() => ({ items: [], pageUrl: '' })));
  }
  return store.get(tabId);
}

function resetTab(tabId, url) {
  store.set(tabId, Promise.resolve({ items: [], pageUrl: url }));
  schedulePersist(tabId, 0);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

export async function clearTab(tabId) {
  const data = await getTabData(tabId);
  resetTab(tabId, data.pageUrl);
  notifyContent(tabId, 0);
}

function schedulePersist(tabId, delay = 400) {
  clearTimeout(persistTimers.get(tabId));
  persistTimers.set(
    tabId,
    setTimeout(async () => {
      persistTimers.delete(tabId);
      const data = await store.get(tabId);
      if (data) chrome.storage.session.set({ ['media:' + tabId]: data }).catch(() => {});
    }, delay),
  );
}

async function addItem(tabId, item) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch { /* the tab may be closed or not shown yet */ }
  if (isVideoBlockedUrl(tab?.url)) return;
  const data = await getTabData(tabId);
  if (isVideoBlockedUrl(data.pageUrl)) return;
  // No await between here and push(), so the same address arriving twice is never added twice
  const key = mediaKey(item.url);
  const existing = data.items.find((x) => x.key === key);
  if (existing) {
    if (item.size && (!existing.size || item.size > existing.size)) {
      existing.size = item.size;
      schedulePersist(tabId);
    }
    if (item.ranged) existing.ranged = true;
    return;
  }
  item.id = uid();
  item.key = key;
  data.items.push(item);
  if (data.items.length > MAX_ITEMS) data.items.splice(0, data.items.length - MAX_ITEMS);
  item.pageUrl = tab?.url || '';
  item.title = tab?.title || '';
  if (item.referer == null) item.referer = item.pageUrl || '';
  schedulePersist(tabId);
  refreshBadge(tabId, data);
  if (needsEnrich(item)) enrich(tabId, item);
}

function needsEnrich(it, deep = false) {
  if (it.invalid) return false;
  if (it.kind === 'hls') return !it.info || (deep && it.info.master && !it.info.detailed && !it.info.error);
  if (it.kind === 'track') return !it.probe;
  if ((it.kind === 'video' || it.kind === 'audio') && it.ranged && it.reqType === 'xmlhttprequest' && isMp4Family(it)) return !it.probe;
  return false;
}

/**
 * Adds details: qualities and duration for HLS, whether a separate track is audio or video.
 * Automatic enrichment only requests addresses the page itself already requested; details of the
 * variants in a master playlist (duration, encryption) are fetched only when the user opens the
 * popup or panel (deep), and only from the same host.
 */
export function enrich(tabId, item, deep = false) {
  const key = item.id + (deep ? ':deep' : '');
  if (enriching.has(key)) return enriching.get(key);
  const p = (async () => {
    try {
      if (item.kind === 'hls') {
        if (!item.info) item.info = await hlsInfo(item);
        if (deep && item.info.master && !item.info.detailed) await hlsDetail(item);
      } else item.probe = await probeTrack(item);
    } catch (e) {
      if (item.kind === 'hls') {
        item.info = { error: String(e?.message || e) };
        // A guessed playlist that turns out not to be M3U8 is dropped
        if (item.guessed || e?.code === 'NOT_M3U8') item.invalid = true;
      } else item.probe = { error: String(e?.message || e) };
    }
    const data = await getTabData(tabId);
    schedulePersist(tabId);
    refreshBadge(tabId, data);
  })().finally(() => enriching.delete(key));
  enriching.set(key, p);
  return p;
}

export async function ensureEnriched(tabId, items, timeoutMs = 5000, deep = false) {
  const ps = items.filter((it) => needsEnrich(it, deep)).map((it) => enrich(tabId, it, deep));
  if (!ps.length) return;
  await Promise.race([Promise.allSettled(ps), new Promise((r) => setTimeout(r, timeoutMs))]);
}

async function fetchText(url, referer) {
  await ensureHeaderRule(url, referer);
  const resp = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function hlsInfo(item) {
  const pl = parseM3U8(await fetchText(item.url, item.referer), item.url);
  if (pl.type === 'master') {
    const info = {
      master: true,
      variants: pl.variants.map((v) => ({ uri: v.uri, width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs, audio: v.audio, name: v.name })),
      audios: pl.media.filter((m) => m.type === 'AUDIO' && m.uri).map((m) => ({ uri: m.uri, name: m.name, language: m.language, groupId: m.groupId, default: m.default })),
    };
    return info;
  }
  return { master: false, duration: pl.duration, live: !pl.endList, encryption: encryptionOf(pl), segments: pl.segments.length, fmp4: pl.maps.length > 0 };
}

/** Duration and encryption of the best variant in a master playlist (same host only, only when the user looks) */
async function hlsDetail(item) {
  const info = item.info;
  info.detailed = true;
  const best = info.variants?.[0];
  if (!best) return;
  let same = false;
  try { same = new URL(best.uri).host === new URL(item.url).host; } catch { /* ignore */ }
  if (!same) return;
  try {
    const p2 = parseM3U8(await fetchText(best.uri, item.referer), best.uri);
    if (p2.type === 'media') {
      info.duration = p2.duration;
      info.live = !p2.endList;
      info.encryption = encryptionOf(p2);
      info.segments = p2.segments.length;
    }
  } catch { /* ignore */ }
}

async function probeTrack(item) {
  await ensureHeaderRule(item.url, item.referer);
  const resp = await fetch(item.url, { headers: { Range: 'bytes=0-131071' }, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < 131072) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const u8 = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    u8.set(c.subarray(0, Math.min(c.byteLength, total - o)), o);
    o += c.byteLength;
  }
  return probeInitBytes(u8) || { track: null, fragmented: false };
}

/** Variant URLs referenced by master playlists (hidden from the list as duplicates) */
export function hiddenUrls(items) {
  const s = new Set();
  for (const it of items) {
    if (it.kind === 'hls' && it.info?.master) {
      for (const v of it.info.variants) s.add(v.uri);
      for (const a of it.info.audios || []) s.add(a.uri);
    }
  }
  return s;
}

let counter = (data) => {
  const hidden = hiddenUrls(data.items);
  return data.items.filter((it) => it.kind !== 'dash' && !hidden.has(it.url)).length;
};

/** Set by media-view so the badge count uses the same grouping as the list */
export function setCounter(fn) {
  counter = fn;
}

export function visibleCount(data) {
  return counter({ ...data, items: data.items.filter((it) => !it.invalid) });
}

function refreshBadge(tabId, data) {
  const n = visibleCount(data);
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  notifyContent(tabId, n);
}

function notifyContent(tabId, count) {
  chrome.tabs.sendMessage(tabId, { to: 'content', cmd: 'media', count }).catch(() => {});
}
