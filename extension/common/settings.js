// Default settings and reading/writing them (chrome.storage.local).

export const DEFAULT_TAKEOVER_EXTS =
  '3gp 7z aac ace aif apk arj asf avi bin bz2 deb dmg doc docx epub exe flac flv gz gzip img iso jar ' +
  'lzh m4a m4v mkv mov mp3 mp4 mpa mpe mpeg mpg msi msu ogg ogv pdf pkg ppt pptx qt r00 r01 ra rar rm ' +
  'rmvb rpm sit sitx tar tgz tif tiff wav webm wma wmv xls xlsx xz z zip zst';

export const DEFAULT_SETTINGS = {
  threads: 6, // connections per download (browsers allow at most 6 per HTTP/1.1 server)
  maxConcurrent: 3, // downloads running at the same time
  speedLimitKB: 0, // global speed limit in KB/s, 0 = unlimited
  retries: 6, // retries per segment
  subfolder: '', // subfolder inside the browser's downloads folder
  categorize: true, // save into folders by file type
  takeover: true, // take over browser downloads
  takeoverExts: DEFAULT_TAKEOVER_EXTS,
  takeoverMinKB: 1024, // don't take over smaller files (when the size is unknown, the extension decides)
  takeoverExclude: '', // sites never taken over, separated by spaces or new lines
  showOverlay: true, // show the “Download video” button over videos
  sniffMinKB: 200, // hide audio/video smaller than this
  notify: true, // notify when done
  hlsFormat: 'mp4', // HLS output format: mp4 | ts
  hlsConcurrency: 6, // HLS segments downloaded at once
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function clampSettings(s) {
  const n = (v, lo, hi, d) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
  };
  return {
    ...s,
    threads: n(s.threads, 1, 32, DEFAULT_SETTINGS.threads),
    maxConcurrent: n(s.maxConcurrent, 1, 10, DEFAULT_SETTINGS.maxConcurrent),
    speedLimitKB: n(s.speedLimitKB, 0, 10_000_000, 0),
    retries: n(s.retries, 0, 50, DEFAULT_SETTINGS.retries),
    takeoverMinKB: n(s.takeoverMinKB, 0, 10_000_000, DEFAULT_SETTINGS.takeoverMinKB),
    sniffMinKB: n(s.sniffMinKB, 0, 1_000_000, DEFAULT_SETTINGS.sniffMinKB),
    hlsConcurrency: n(s.hlsConcurrency, 1, 16, DEFAULT_SETTINGS.hlsConcurrency),
  };
}
