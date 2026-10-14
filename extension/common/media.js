// Media detection rules: decides from the URL and response headers whether a request is downloadable audio or video. Pure functions.
import { baseMime, extOf, HLS_MIMES, VIDEO_EXTS, AUDIO_EXTS, parseContentDisposition, parseContentRange } from './util.js';

const SEGMENT_EXTS = new Set(['m4s', 'cmfv', 'cmfa', 'm4f']);
const NOT_MEDIA_MIME = /^(text\/(?!vtt)|application\/(json|javascript|x-javascript|xml|xhtml\+xml)|image\/)/;
// Typical ad, analytics and notification-sound hosts or paths (keeps the list free of noise)
const NOISE = /(doubleclick|googlesyndication|adservice|\/ads?\/|\/adv?\/|beacon|analytics|tracking)/i;

export function headersToObject(list) {
  const h = {};
  for (const x of list || []) h[x.name.toLowerCase()] = x.value ?? '';
  return h;
}

/**
 * @param d { url, statusCode, responseHeaders (webRequest format) }
 * @param minBytes ignore plain audio/video files smaller than this
 * @returns {null | {kind:'hls'|'dash'|'video'|'audio'|'track', ext, mime, size, filename, ranged}}
 */
export function classifyResponse(d, minBytes = 0) {
  const status = d.statusCode || 0;
  if (status >= 400 || status === 204 || (status >= 300 && status < 400 && status !== 304)) return null;
  let u;
  try {
    u = new URL(d.url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = headersToObject(d.responseHeaders);
  const mime = baseMime(h['content-type']);
  const ext = extOf(u.pathname.toLowerCase());
  const cr = parseContentRange(h['content-range']);
  const len = h['content-length'] ? Number(h['content-length']) : null;
  const size = cr?.total ?? (status === 200 && Number.isFinite(len) ? len : null);
  const filename = parseContentDisposition(h['content-disposition']);
  const ranged = status === 206;
  const base = { ext, mime, size, filename, ranged };

  if (HLS_MIMES.has(mime) || ext === 'm3u8') return { kind: 'hls', ...base };
  // Some sites serve playlists without a .m3u8 extension or a proper type, but with “m3u8” in the address.
  // Treat them as candidates; they are dropped automatically if they don't parse
  if (/m3u8/i.test(u.pathname + u.search) && /^(text\/plain|application\/octet-stream|binary\/octet-stream|)$/.test(mime) && !(size > 2 * 1024 * 1024)) {
    return { kind: 'hls', ...base, guessed: true };
  }
  if (mime === 'application/dash+xml' || ext === 'mpd') return { kind: 'dash', ...base };
  if (NOT_MEDIA_MIME.test(mime)) return null;
  if (NOISE.test(u.hostname + u.pathname)) return null;

  if (SEGMENT_EXTS.has(ext) || mime === 'video/iso.segment' || mime === 'audio/iso.segment') {
    // Only whole audio/video tracks fetched with Range requests (e.g. separate m4s tracks) are useful; small standalone segments are ignored
    if (ranged && cr?.total && cr.total >= 256 * 1024) return { kind: 'track', ...base, size: cr.total };
    if (size && size >= 10 * 1024 * 1024) return { kind: 'track', ...base };
    return null;
  }
  if (ext === 'ts' || mime === 'video/mp2t') {
    return size && size >= 50 * 1024 * 1024 ? { kind: 'video', ...base } : null;
  }
  let kind = null;
  if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  else if (VIDEO_EXTS.has(ext)) kind = 'video';
  else if (AUDIO_EXTS.has(ext)) kind = 'audio';
  if (!kind) return null;
  if (size != null && size < minBytes) return null;
  return { kind, ...base };
}

/** Strips range-related query parameters from a URL, for de-duplication */
export function mediaKey(url) {
  try {
    const u = new URL(url);
    for (const p of ['range', 'bytes', 'start', 'end', 'rn', 'rbuf', '_']) u.searchParams.delete(p);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

export function isMp4Family(item) {
  return /^(video|audio)\/mp4$/.test(item.mime || '') || ['mp4', 'm4v', 'm4a', 'm4s', 'cmfv', 'cmfa'].includes(item.ext);
}
