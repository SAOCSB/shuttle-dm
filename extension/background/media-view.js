// Turns the raw detected requests into download entries for the popup and the in-page video panel.

import { getTabData, ensureEnriched, hiddenUrls, setCounter } from './sniffer.js';
import { formatBytes, formatDuration, filenameFromUrl, sanitizeFilename, stripExt, qualityLabel } from '../common/util.js';
import { codecHint } from '../common/m3u8.js';
import { i18n, tp } from '../common/i18n.js';

const TAIL = /^(.*?\S)\s*(?:\s[-|–—·]\s|[_|｜])\s*([^-|–—·_｜]{1,24})$/;
const COMMON_HOST_PARTS = new Set(['www', 'com', 'net', 'org', 'cn', 'm', 'tv', 'video', 'videos']);

/** Parts of the host name that are likely the site's name, e.g. www.example.com → ['example'] */
function siteWords(pageUrl) {
  try {
    return new URL(pageUrl).hostname.toLowerCase().split('.').filter((w) => w.length >= 3 && !COMMON_HOST_PARTS.has(w));
  } catch {
    return [];
  }
}

/** When a page title becomes a file name, drop the site name at the end, e.g. “Title - Example”, “标题_某某网” */
export function cleanTitle(title, pageUrl = '') {
  const raw = String(title || '').trim();
  const words = siteWords(pageUrl);
  let t = raw;
  for (let i = 0; i < 3; i++) {
    const m = TAIL.exec(t);
    if (!m) break;
    const tail = m[2].toLowerCase().replace(/\s+/g, '');
    const isSite = words.some((w) => tail.includes(w)) || (tail.length <= 8 && /(网|站|官网|在线观看)$/.test(tail));
    if (!isSite) break;
    t = m[1].trim();
  }
  return sanitizeFilename(t || raw, '');
}

const PRIORITY = { merge: 0, hls: 1, video: 2, track: 3, audio: 4, dash: 5 };

setCounter((data) => buildEntries(data.items, '', '').filter((e) => e.kind !== 'dash').length);

function codecName(fourcc) {
  if (!fourcc) return '';
  if (/^avc/.test(fourcc)) return 'H.264';
  if (/^(hvc|hev)/.test(fourcc)) return 'HEVC';
  if (/^av01/.test(fourcc)) return 'AV1';
  if (/^vp0?9/.test(fourcc)) return 'VP9';
  if (/^mp4a/.test(fourcc)) return 'AAC';
  if (/^(ac-3|ec-3)/.test(fourcc)) return 'Dolby';
  if (/^(Opus|opus)/.test(fourcc)) return 'Opus';
  if (/^fLaC/.test(fourcc)) return 'FLAC';
  return fourcc;
}

export async function getMediaView(tabId) {
  const data = await getTabData(tabId);
  // The user opened the list, so it is fine to fetch more details (variant duration, encryption)
  await ensureEnriched(tabId, data.items, 5000, true);
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* ignore */ }
  const title = tab?.title || data.items.at(-1)?.title || '';
  const pageUrl = tab?.url || data.pageUrl || '';
  return { title, pageUrl, entries: buildEntries(data.items, title, pageUrl) };
}

export function buildEntries(items, title, pageUrl) {
  const base = cleanTitle(title, pageUrl) || 'video';
  const hidden = hiddenUrls(items);
  const entries = [];
  const vTracks = [];
  const aTracks = [];
  const common = (it) => ({ referer: it.referer || it.pageUrl || pageUrl, pageUrl: it.pageUrl || pageUrl, pageTitle: title });

  for (const it of [...items].sort((a, b) => b.time - a.time)) {
    if (hidden.has(it.url) || it.invalid) continue;
    if (it.kind === 'hls') {
      entries.push(hlsEntry(it, base, common(it)));
    } else if (it.kind === 'dash') {
      entries.push({
        id: it.id, kind: 'dash', icon: 'stream', title: base,
        meta: [i18n('dashManifest'), it.size ? formatBytes(it.size) : ''].filter(Boolean),
        note: i18n('dashNote'), warn: true,
        action: 'copy', url: it.url, time: it.time,
      });
    } else if (it.probe?.track === 'video' || it.probe?.track === 'audio') {
      if (it.probe.encrypted) {
        entries.push({ id: it.id, kind: 'track', icon: 'stream', title: base, meta: [i18n('encryptedTrack')], note: i18n('drmMediaNote'), warn: true, disabled: true, action: 'download', url: it.url, time: it.time });
      } else (it.probe.track === 'video' ? vTracks : aTracks).push(it);
    } else {
      const name = it.filename || filenameFromUrl(it.url) || base;
      const isAudio = it.kind === 'audio';
      entries.push({
        id: it.id,
        kind: it.kind === 'track' ? 'track' : isAudio ? 'audio' : 'video',
        icon: isAudio ? 'audio' : 'video',
        title: name,
        meta: [(it.ext || it.mime.split('/')[1] || '').toUpperCase(), it.size ? formatBytes(it.size) : i18n('sizeUnknown')].filter(Boolean),
        url: it.url,
        action: 'download',
        params: { type: 'http', url: it.url, size: it.size || null, mime: it.mime, filename: it.filename || '', ...common(it) },
        time: it.time,
      });
    }
  }

  if (vTracks.length || aTracks.length) entries.push(...trackEntries(vTracks, aTracks, base, common));
  entries.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || (b.time || 0) - (a.time || 0));
  return entries;
}

function hlsEntry(it, base, common) {
  const info = it.info || {};
  const meta = ['HLS'];
  if (info.duration) meta.push(formatDuration(info.duration));
  if (info.live) meta.push(i18n('live'));
  if (info.encryption === 'aes-128') meta.push('AES-128');
  const entry = {
    id: it.id,
    kind: 'hls',
    icon: 'stream',
    title: base,
    meta,
    url: it.url,
    time: it.time,
    action: info.live ? 'record' : 'download',
  };
  if (info.error) {
    entry.note = i18n('playlistParseFailed', info.error);
    entry.warn = true;
  }
  if (info.encryption === 'drm') {
    entry.note = i18n('drmVideoNote');
    entry.warn = true;
    entry.disabled = true;
  }
  if (info.master && info.variants?.length) {
    const multi = info.variants.length > 1;
    entry.choices = info.variants.map((v) => {
      const q = qualityLabel(v);
      const hint = codecHint(v.codecs);
      return {
        label: [hint && hint !== 'H.264' ? hint : '', q || i18n('defaultQuality')].filter(Boolean).join(' '),
        params: {
          type: 'hls', url: it.url, variant: v.uri, quality: q,
          variantInfo: { bandwidth: v.bandwidth, height: v.height, codecs: v.codecs },
          filename: `${base}${multi && v.height ? `_${v.height}p` : ''}.mp4`, ...common,
        },
      };
    });
    for (const a of info.audios || []) {
      entry.choices.push({
        label: i18n('audioOnly', a.name || a.language || a.groupId),
        params: { type: 'hls', url: a.uri, filename: `${base}_${sanitizeFilename(a.name || a.language || 'audio')}.m4a`, ...common },
      });
    }
  } else {
    if (info.segments) meta.push(tp('segmentCount', info.segments));
    entry.params = { type: 'hls', url: it.url, filename: `${base}.mp4`, ...common };
  }
  return entry;
}

function trackLabel(it) {
  const p = it.probe || {};
  const codec = codecName(p.codec);
  // like HLS qualities, only name the codec when it isn't the usual H.264
  const head = [p.track === 'video' && p.height ? `${Math.round(p.height)}p` : '', codec === 'H.264' ? '' : codec].filter(Boolean).join(' ');
  return it.size ? i18n('labelWithDetail', head || i18n('track'), formatBytes(it.size)) : head || i18n('track');
}

function trackEntries(vTracks, aTracks, base, common) {
  const out = [];
  const byQuality = (a, b) => (b.probe.height || 0) - (a.probe.height || 0) || (b.size || 0) - (a.size || 0);
  vTracks.sort(byQuality);
  aTracks.sort((a, b) => (b.size || 0) - (a.size || 0));
  const bestAudio = aTracks[0];
  const part = (it, role) => ({ url: it.url, role, size: it.size || null });
  if (vTracks.length) {
    const choices = vTracks.map((v) => ({
      label: i18n(bestAudio ? 'trackWithAudio' : 'trackNoAudio', trackLabel(v)),
      params: {
        type: 'merge',
        url: v.url,
        parts: bestAudio ? [part(v, 'video'), part(bestAudio, 'audio')] : [part(v, 'video')],
        filename: `${base}${vTracks.length > 1 && v.probe.height ? `_${Math.round(v.probe.height)}p` : ''}.mp4`,
        size: (v.size || 0) + (bestAudio?.size || 0) || null,
        ...common(v),
      },
    }));
    for (const a of aTracks) {
      choices.push({ label: i18n('audioOnly', trackLabel(a)), params: { type: 'merge', url: a.url, parts: [part(a, 'audio')], filename: `${base}.m4a`, ...common(a) } });
    }
    out.push({
      id: 'merge-' + vTracks[0].id,
      kind: 'merge',
      icon: 'merge',
      title: base,
      meta: [bestAudio ? i18n('separateStreams') : i18n('videoTrack'), i18n('mergeToMp4')],
      choices,
      url: vTracks[0].url,
      action: 'download',
      time: Math.max(...vTracks.map((x) => x.time)),
    });
  } else {
    for (const a of aTracks) {
      out.push({
        id: a.id, kind: 'audio', icon: 'audio', title: `${stripExt(base)}.m4a`, meta: [i18n('audioTrack'), trackLabel(a)],
        url: a.url, action: 'download',
        params: { type: 'merge', url: a.url, parts: [part(a, 'audio')], filename: `${base}.m4a`, ...common(a) },
        time: a.time,
      });
    }
  }
  return out;
}
