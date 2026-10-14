// Shared helpers for the background, the engine and the UI. No DOM access; text goes through i18n.js.

import { i18n, formatNumber } from './i18n.js';

const category = (id, key) => ({
  id,
  get name() { return i18n(key); },
  get folder() { return i18n(key); },
});

export const CATEGORY_LIST = [
  category('video', 'catVideo'),
  category('audio', 'catAudio'),
  category('document', 'catDocument'),
  category('archive', 'catArchive'),
  category('program', 'catProgram'),
  category('image', 'catImage'),
  category('page', 'catPage'),
  category('other', 'catOther'),
];

const EXT_GROUPS = {
  video: '3gp 3g2 asf avi f4v flv m2ts m4v mkv mov mp4 mpe mpeg mpg mts ogv qt rm rmvb ts vob webm wmv',
  audio: 'aac ac3 aif aifc aiff amr ape au caf dts flac m4a m4b mid midi mka mp2 mp3 mpa oga ogg opus ra wav weba wma wv',
  document: 'azw3 chm csv djvu doc docm docx epub key md mobi numbers odp ods odt pages pdf pps ppsx ppt pptm pptx ps rtf tex txt vsd vsdx xls xlsm xlsx xps',
  archive: '7z ace arj br bz2 cab gz gzip img iso jar lha lz lz4 lzh lzma r00 r01 rar sit sitx tar taz tbz tbz2 tgz txz tz xz z zip zipx zst',
  program: 'apk apks appimage aab bat bin crx deb dmg exe flatpak ipa msi msix msixbundle msu pkg rpm run sh snap xpi',
  image: 'apng avif bmp gif heic heif ico jfif jpeg jpg png psd svg tif tiff webp',
  page: 'htm html mht mhtml shtml xhtml',
};

const EXT_TO_CAT = {};
for (const [cat, list] of Object.entries(EXT_GROUPS)) for (const e of list.split(' ')) EXT_TO_CAT[e] = cat;

export const VIDEO_EXTS = new Set(EXT_GROUPS.video.split(' ').filter((e) => e !== 'ts'));
export const AUDIO_EXTS = new Set(EXT_GROUPS.audio.split(' '));

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov',
  'video/x-flv': 'flv', 'video/x-msvideo': 'avi', 'video/mp2t': 'ts', 'video/3gpp': '3gp', 'video/ogg': 'ogv',
  'video/x-ms-wmv': 'wmv', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'weba', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar', 'application/vnd.rar': 'rar', 'application/gzip': 'gz',
  'application/x-gzip': 'gz', 'application/x-tar': 'tar', 'application/x-bzip2': 'bz2', 'application/x-xz': 'xz',
  'application/x-msdownload': 'exe', 'application/x-msdos-program': 'exe', 'application/x-msi': 'msi',
  'application/x-apple-diskimage': 'dmg', 'application/vnd.android.package-archive': 'apk',
  'application/x-debian-package': 'deb', 'application/x-iso9660-image': 'iso', 'application/json': 'json',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub', 'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html',
  'application/xhtml+xml': 'html', 'multipart/related': 'mhtml', 'application/x-mimearchive': 'mhtml',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff', 'image/heic': 'heic',
};

export const HLS_MIMES = new Set([
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl',
  'application/mpegurl', 'video/x-mpegurl', 'video/mpegurl',
]);

export function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

export function extOf(name) {
  const clean = String(name || '').split(/[?#]/)[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  const ext = base.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export function extFromMime(mime) {
  return MIME_EXT[baseMime(mime)] || '';
}

export function categoryOf(filename, mime) {
  const ext = extOf(filename);
  if (ext && EXT_TO_CAT[ext]) return EXT_TO_CAT[ext];
  const m = baseMime(mime);
  if (m.startsWith('video/') || HLS_MIMES.has(m)) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  if (m === 'text/html' || m === 'multipart/related') return 'page';
  const viaMime = extFromMime(m);
  if (viaMime && EXT_TO_CAT[viaMime]) return EXT_TO_CAT[viaMime];
  return 'other';
}

export function categoryFolder(cat) {
  return (CATEGORY_LIST.find((c) => c.id === cat) || CATEGORY_LIST[CATEGORY_LIST.length - 1]).folder;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Cleans a file name so chrome.downloads and every OS accept it. */
export function sanitizeFilename(name, fallback = 'download') {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\\/:*?"<>|~]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  const dot = s.lastIndexOf('.');
  let base = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : '';
  if (WIN_RESERVED.test(base)) base = '_' + base;
  // Limit the length (roughly, in UTF-16 code units) to avoid overly long paths
  const maxBase = Math.max(1, 150 - ext.length);
  if (base.length > maxBase) base = base.slice(0, maxBase).trim();
  s = (base + ext).replace(/[.\s]+$/g, '');
  return s || fallback;
}

/** Cleans a relative subfolder path (e.g. "Videos/Trips"), one level at a time. */
export function sanitizeSubpath(p) {
  return String(p || '')
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeFilename(seg, '_'))
    .join('/');
}

export function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** File name from a URL (without an extension if the URL has none). */
export function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    let last = segs.length ? safeDecodeURIComponent(segs[segs.length - 1]) : '';
    if (!last) last = u.hostname;
    return last;
  } catch {
    return '';
  }
}

/** Re-decodes a byte string that was read as Latin-1 as UTF-8 or GBK (fixes garbled non-ASCII file names). */
export function fixMojibake(str) {
  if (!str || !/[\u0080-\u00ff]/.test(str) || /[^\u0000-\u00ff]/.test(str)) return str;
  const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0));
  for (const enc of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch { /* try next */ }
  }
  return str;
}

/** File name from a Content-Disposition header, or ''. Supports RFC 5987 filename*. */
export function parseContentDisposition(value) {
  if (!value) return '';
  const v = String(value);
  const star = /filename\*\s*=\s*([^;]+)/i.exec(v);
  if (star) {
    let raw = star[1].trim().replace(/^"(.*)"$/, '$1');
    const m = /^([\w!#$%&+^`{}-]*)'[^']*'(.*)$/.exec(raw);
    if (m) {
      const charset = (m[1] || 'utf-8').toLowerCase();
      const enc = m[2];
      try {
        if (charset === 'utf-8' || charset === 'utf8') return decodeURIComponent(enc);
        const bytes = [];
        for (let i = 0; i < enc.length; i++) {
          if (enc[i] === '%' && /^[0-9a-f]{2}$/i.test(enc.slice(i + 1, i + 3))) {
            bytes.push(parseInt(enc.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(enc.charCodeAt(i) & 0xff);
        }
        return new TextDecoder(charset === 'iso-8859-1' ? 'latin1' : charset).decode(new Uint8Array(bytes));
      } catch { /* fall through */ }
    }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(v);
  if (quoted) return fixMojibake(safeDecodeIfEncoded(quoted[1].replace(/\\(.)/g, '$1')));
  const token = /filename\s*=\s*([^;\s]+)/i.exec(v);
  if (token) return fixMojibake(safeDecodeIfEncoded(token[1]));
  return '';
}

function safeDecodeIfEncoded(s) {
  return /%[0-9a-f]{2}/i.test(s) ? safeDecodeURIComponent(s) : s;
}

/** Parses Content-Range: bytes 0-99/1000 → {start, end, total}. */
export function parseContentRange(value) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/** Makes sure a file name has a sensible extension. */
export function ensureExt(name, mime, fallbackExt = '') {
  const ext = extOf(name);
  const fromMime = extFromMime(mime);
  if (ext) {
    // The server sent HTML but the URL looks like another file (e.g. download.php): add .html
    if (fromMime === 'html' && !['htm', 'html', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp'].includes(ext)) return name;
    if (['php', 'asp', 'aspx', 'jsp', 'cgi', 'do', 'action'].includes(ext) && fromMime && fromMime !== 'html') {
      return name.slice(0, -(ext.length + 1)) + '.' + fromMime;
    }
    return name;
  }
  const add = fromMime || fallbackExt;
  return add ? `${name}.${add}` : name;
}

export function replaceExt(name, newExt) {
  const ext = extOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  return `${base}.${newExt}`;
}

export function stripExt(name) {
  const ext = extOf(name);
  return ext ? name.slice(0, -(ext.length + 1)) : name;
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function formatBytes(n, digits = 1) {
  if (n == null || !isFinite(n) || n < 0) return '—';
  if (n < 1024) return i18n('unitB', formatNumber(n));
  const units = ['unitKB', 'unitMB', 'unitGB', 'unitTB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return i18n(units[i], formatNumber(v, v >= 100 ? 0 : digits));
}

export function formatSpeed(bps) {
  if (!bps || bps < 1) return '—';
  return i18n('perSecond', formatBytes(bps));
}

export function formatDuration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return i18n('etaSeconds', Math.max(1, Math.round(sec)));
  if (sec < 3600) return i18n('etaMinutes', Math.floor(sec / 60), Math.round(sec % 60));
  if (sec < 86400) return i18n('etaHours', Math.floor(sec / 3600), Math.round((sec % 3600) / 60));
  return i18n('etaDays', Math.floor(sec / 86400));
}

function dateFormat(opts) {
  try {
    return new Intl.DateTimeFormat(i18n('localeTag'), opts);
  } catch {
    return new Intl.DateTimeFormat('en', opts);
  }
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hm = dateFormat({ hour: '2-digit', minute: '2-digit' }).format(d);
  if (d.toDateString() === now.toDateString()) return i18n('timeToday', hm);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return i18n('timeYesterday', hm);
  const sameYear = d.getFullYear() === now.getFullYear();
  return dateFormat({ ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(e) {
  return e?.name === 'AbortError';
}

/** Quality label such as "720p (2.3 Mbps)" from height, name and bandwidth. */
export function qualityLabel({ height, bandwidth, name } = {}) {
  const head = height ? `${height}p` : name || '';
  const rate = bandwidth ? (bandwidth >= 1e6 ? `${formatNumber(bandwidth / 1e6, 1)} Mbps` : `${formatNumber(Math.round(bandwidth / 1e3))} kbps`) : '';
  if (head && rate) return i18n('labelWithDetail', head, rate);
  return head || rate;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
