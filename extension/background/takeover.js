// Browser download takeover: matching downloads are handed to the multi-connection engine.
// The browser's download is only cancelled after the engine confirms its first response is the same
// file; otherwise the browser carries on, so a download is never lost.

import { engine } from './engine-client.js';
import { extOf, extFromMime, filenameFromUrl, hostOf } from '../common/util.js';
import { isVideoBlockedUrl } from '../common/sites.js';

const bypass = new Map();
const pendingNames = new Map();

/** Let the next download of this URL go through the browser (batch download with “The browser’s own downloader”) */
export function allowBrowserDownload(url) {
  bypass.set(url, Date.now() + 120000);
}

/**
 * Remembers the file name for a download started by this extension.
 * Note: once onDeterminingFilename has a listener, the filename passed to chrome.downloads.download
 * is ignored, so the listener has to suggest it again.
 */
export function rememberFilename(url, filename) {
  pendingNames.set(url, filename);
  setTimeout(() => pendingNames.delete(url), 60000);
}

export function initTakeover(getSettings) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId === chrome.runtime.id) {
      const name = pendingNames.get(item.url) || pendingNames.get(item.finalUrl);
      pendingNames.delete(item.url);
      if (name) suggest({ filename: name, conflictAction: 'uniquify' });
      else suggest();
      return false;
    }
    decide(item, getSettings)
      .catch((e) => {
        console.warn('[takeover]', e);
        return false;
      })
      .then(async (taken) => {
        if (taken) {
          try { await chrome.downloads.cancel(item.id); } catch { /* ignore */ }
          try { await chrome.downloads.erase({ id: item.id }); } catch { /* ignore */ }
        }
        try { suggest(); } catch { /* already cancelled */ }
      });
    return true;
  });
}

async function decide(item, getSettings) {
  if (item.byExtensionId === chrome.runtime.id) return false;
  if (item.state !== 'in_progress' || item.incognito) return false;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return false;
  if (isVideoBlockedUrl(url) || isVideoBlockedUrl(item.url)) return false; // leave it to the browser
  for (const u of [url, item.url]) {
    const exp = bypass.get(u);
    if (exp) {
      bypass.delete(u);
      if (exp > Date.now()) return false;
    }
  }
  const s = await getSettings();
  if (!s.takeover) return false;
  const host = hostOf(url);
  const excludes = String(s.takeoverExclude || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (excludes.some((x) => host === x || host.endsWith('.' + x))) return false;
  const name = (item.filename || '').split(/[\\/]/).pop() || filenameFromUrl(url);
  const ext = extOf(name) || extFromMime(item.mime);
  const exts = new Set(String(s.takeoverExts || '').toLowerCase().split(/[\s,;]+/).filter(Boolean));
  if (!ext || !exts.has(ext)) return false;
  if (item.totalBytes > 0 && item.totalBytes < s.takeoverMinKB * 1024) return false;

  const res = await Promise.race([
    engine('add', {
      task: {
        url,
        referer: item.referrer || '',
        filename: name,
        mime: item.mime || '',
        size: item.totalBytes > 0 ? item.totalBytes : null,
        source: 'takeover',
        takeover: { downloadId: item.id, expectSize: item.totalBytes > 0 ? item.totalBytes : null, expectExt: ext },
      },
    }),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 20000)),
  ]);
  if (res?.timeout) return false;
  return !!res?.accepted;
}
