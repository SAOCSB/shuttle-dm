// HLS (M3U8) playlist parsing. Pure functions.

import { i18n } from './i18n.js';

export function parseAttributes(str) {
  const attrs = {};
  const re = /\s*([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|[^,]*)\s*(?:,|$)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1].toUpperCase()] = v;
    if (re.lastIndex === m.index) re.lastIndex++;
    if (re.lastIndex >= str.length) break;
  }
  return attrs;
}

function resolveUrl(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

function parseByteRange(spec) {
  const m = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(spec || '');
  if (!m) return null;
  return { length: Number(m[1]), offset: m[2] != null ? Number(m[2]) : null };
}

export function isM3U8Text(text) {
  return /^﻿?\s*#EXTM3U/.test(text || '');
}

/**
 * Parses M3U8 text.
 * A master playlist returns { type:'master', variants, media }
 * A media playlist returns { type:'media', segments, keys, maps, duration, endList, ... }
 */
export function parseM3U8(text, baseUrl) {
  if (!isM3U8Text(text)) throw Object.assign(new Error(i18n('errNotM3u8')), { code: 'NOT_M3U8' });
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, base) {
  const variants = [];
  const media = [];
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      media.push({
        type: (a.TYPE || '').toUpperCase(),
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        channels: a.CHANNELS || '',
        uri: a.URI ? resolveUrl(a.URI, base) : null,
      });
    } else if (!line.startsWith('#') && pending) {
      const res = /(\d+)\s*x\s*(\d+)/i.exec(pending.RESOLUTION || '');
      variants.push({
        uri: resolveUrl(line, base),
        bandwidth: Number(pending.BANDWIDTH) || Number(pending['AVERAGE-BANDWIDTH']) || 0,
        averageBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || 0,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        codecs: pending.CODECS || '',
        frameRate: Number(pending['FRAME-RATE']) || 0,
        audio: pending.AUDIO || null,
        name: pending.NAME || '',
      });
      pending = null;
    }
  }
  // De-duplicate (keep the highest bitrate entry for each URI)
  const byUri = new Map();
  for (const v of variants) {
    const old = byUri.get(v.uri);
    if (!old || v.bandwidth > old.bandwidth) byUri.set(v.uri, v);
  }
  const list = [...byUri.values()].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return { type: 'master', variants: list, media };
}

function parseMedia(lines, base) {
  const segments = [];
  const keys = [];
  const maps = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType = '';
  let keyIndex = -1;
  let mapIndex = -1;
  let dur = null;
  let byterange = null;
  let discontinuity = false;
  const lastEnd = new Map();

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const v = line.slice(8);
      const c = v.indexOf(',');
      dur = parseFloat(c >= 0 ? v.slice(0, c) : v);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21).trim().toUpperCase();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') keyIndex = -1;
      else {
        keys.push({
          method,
          uri: a.URI ? resolveUrl(a.URI, base) : null,
          iv: a.IV || null,
          keyformat: a.KEYFORMAT || 'identity',
        });
        keyIndex = keys.length - 1;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      const br = a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null;
      maps.push({ uri: resolveUrl(a.URI, base), byterange: br ? { length: br.length, offset: br.offset ?? 0 } : null });
      mapIndex = maps.length - 1;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byterange = parseByteRange(line.slice(17));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (!line.startsWith('#')) {
      const uri = resolveUrl(line, base);
      let br = null;
      if (byterange) {
        const offset = byterange.offset ?? lastEnd.get(uri) ?? 0;
        br = { offset, length: byterange.length };
        lastEnd.set(uri, offset + byterange.length);
        byterange = null;
      }
      segments.push({
        uri,
        duration: Number.isFinite(dur) ? dur : targetDuration,
        seq: mediaSequence + segments.length,
        key: keyIndex,
        map: mapIndex,
        byterange: br,
        discontinuity,
      });
      dur = null;
      discontinuity = false;
    }
  }
  const duration = segments.reduce((a, s) => a + (s.duration || 0), 0);
  return {
    type: 'media',
    segments,
    keys,
    maps,
    targetDuration,
    mediaSequence,
    endList: endList || playlistType === 'VOD',
    playlistType,
    duration,
  };
}

/** Encryption method: 'none' | 'aes-128' | 'drm' */
export function encryptionOf(pl) {
  if (!pl || pl.type !== 'media') return 'none';
  let result = 'none';
  const used = new Set(pl.segments.map((s) => s.key).filter((k) => k >= 0));
  for (const i of used) {
    const k = pl.keys[i];
    const fmt = (k.keyformat || 'identity').toLowerCase();
    if (k.method === 'AES-128' && fmt === 'identity' && k.uri) result = 'aes-128';
    else return 'drm';
  }
  return result;
}

/** Codec name from an HLS CODECS attribute */
export function codecHint(codecs) {
  const c = (codecs || '').toLowerCase();
  if (/hvc1|hev1/.test(c)) return 'HEVC';
  if (/av01/.test(c)) return 'AV1';
  if (/vp09|vp9/.test(c)) return 'VP9';
  if (/avc1|avc3/.test(c)) return 'H.264';
  return '';
}

/** The AES-128 IV (16 bytes). Defaults to the segment's media sequence number. */
export function ivFor(key, seq) {
  const iv = new Uint8Array(16);
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    let n = BigInt(seq);
    for (let i = 15; i >= 0 && n > 0n; i--) {
      iv[i] = Number(n & 0xffn);
      n >>= 8n;
    }
  }
  return iv;
}
