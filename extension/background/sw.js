// Background service worker: message routing, media detection, context menus, download takeover, saving files, notifications.

import { DEFAULT_SETTINGS, getSettings, clampSettings } from '../common/settings.js';
import { sanitizeFilename, extOf, uid, sanitizeSubpath } from '../common/util.js';
import { isVideoBlockedUrl, blockedSiteMessage } from '../common/sites.js';
import { i18n } from '../common/i18n.js';
import { initSniffer, setSniffMinKB, clearTab, getTabData, visibleCount } from './sniffer.js';
import { getMediaView } from './media-view.js';
import { initTakeover, allowBrowserDownload, rememberFilename } from './takeover.js';
import { engine, engineIfRunning, ensureEngine } from './engine-client.js';
import { ensureHeaderRule } from './headers.js';
import { savePage, grabLinks, openManager } from './page.js';

let settingsCache = null;

async function settings() {
  if (!settingsCache) settingsCache = clampSettings(await getSettings());
  return settingsCache;
}

// ---------- Startup ----------

initSniffer();
initTakeover(settings);
settings().then((s) => setSniffMinKB(s.sniffMinKB));

chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  chrome.action.setBadgeBackgroundColor({ color: '#E8590C' }).catch(() => {});
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {});
  const { settings: saved } = await chrome.storage.local.get('settings');
  if (!saved) await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  if (details.reason === 'install') openManager('?welcome=1');
  // Tabs that were already open don't get the content script automatically; inject it so users don't have to reload
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const t of tabs) {
      if (isVideoBlockedUrl(t.url)) continue;
      chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content/content.js'] }).catch(() => {});
    }
  } catch { /* ignore */ }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#E8590C' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  settingsCache = clampSettings({ ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) });
  setSniffMinKB(settingsCache.sniffMinKB);
  engineIfRunning('settings', { settings: settingsCache }).catch(() => {});
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'open-manager') openManager();
});

// ---------- Context menus ----------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const mk = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
    mk('dl-link', i18n('menuDownloadLink'), ['link']);
    mk('dl-media', i18n('menuDownloadMedia'), ['video', 'audio']);
    mk('dl-image', i18n('menuDownloadImage'), ['image']);
    mk('grab-selection', i18n('menuGrabSelection'), ['selection']);
    mk('grab-all', i18n('menuGrabAll'), ['page', 'frame']);
    mk('save-mhtml', i18n('menuSaveMhtml'), ['page', 'frame']);
    mk('save-html', i18n('menuSaveHtml'), ['page', 'frame']);
    mk('open-manager', i18n('cmdOpenManager'), ['action']);
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  onMenu(info, tab).catch((e) => notify(i18n('notifyActionFailed'), String(e?.message || e)));
});

async function onMenu(info, tab) {
  const ctx = { referer: info.frameUrl || info.pageUrl || '', pageUrl: info.pageUrl || '', pageTitle: tab?.title || '' };
  switch (info.menuItemId) {
    case 'dl-link':
      return addAndToast({ url: info.linkUrl, ...ctx });
    case 'dl-image':
      if (/^data:/i.test(info.srcUrl)) {
        const filename = `image_${Date.now()}.${(/^data:image\/(\w+)/i.exec(info.srcUrl)?.[1] || 'png').replace('jpeg', 'jpg')}`;
        rememberFilename(info.srcUrl, filename);
        return chrome.downloads.download({ url: info.srcUrl, filename });
      }
      return addAndToast({ url: info.srcUrl, ...ctx });
    case 'dl-media':
      if ([info.pageUrl, info.frameUrl, info.srcUrl].some(isVideoBlockedUrl)) return notify(i18n('siteNotSupported'), blockedSiteMessage());
      if (/^https?:/i.test(info.srcUrl || '')) return addAndToast({ url: info.srcUrl, ...ctx });
      // blob: / MSE playback: open the list of detected media on the page
      return chrome.tabs.sendMessage(tab.id, { to: 'content', cmd: 'showPanel' }, { frameId: info.frameId ?? 0 }).catch(() =>
        notify(i18n('notifyNoMediaTitle'), i18n('notifyNoMediaBody')),
      );
    case 'grab-selection':
      return grabLinks(tab.id, { selection: true, frameId: info.frameId ?? 0 });
    case 'grab-all':
      return grabLinks(tab.id, {});
    case 'save-mhtml':
      return savePage(tab.id, 'mhtml');
    case 'save-html':
      return savePage(tab.id, 'html');
    case 'open-manager':
      return openManager();
  }
}

async function addAndToast(params) {
  if (isVideoBlockedUrl(params.url)) return notify(i18n('siteNotSupported'), blockedSiteMessage());
  const r = await engine('add', { task: params });
  if (r.duplicates?.length && !r.ids?.length) notify(i18n('alreadyInList'), params.url);
  return r;
}

/** Drops addresses of unsupported sites (see common/sites.js); throws if nothing is left */
function allowedTasks(tasks) {
  const ok = (tasks || []).filter((t) => t && !isVideoBlockedUrl(t.url));
  if (tasks?.length && !ok.length) throw new Error(blockedSiteMessage());
  return ok;
}

// ---------- Notifications ----------

function notify(title, message, id = 'msg:' + uid()) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: String(message || '').slice(0, 300), priority: 0 }).catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  const m = /^task:([^:]+)/.exec(id);
  openManager(m ? `?task=${m[1]}` : '');
  chrome.notifications.clear(id);
});

// ---------- Saving files ----------

async function saveFile({ url, filename }) {
  const ext = extOf(filename) || 'bin';
  const base = sanitizeFilename(filename.split('/').pop());
  // Try in turn: full path → file name only → ASCII-only name (some system locales reject non-ASCII paths)
  const candidates = [filename, sanitizeSubpath(filename), base, /^[\x20-\x7e]+$/.test(base) ? '' : `download_${Date.now()}.${ext}`];
  let lastErr;
  for (const fn of [...new Set(candidates.filter(Boolean))]) {
    try {
      rememberFilename(url, fn);
      const id = await chrome.downloads.download({ url, filename: fn, conflictAction: 'uniquify', saveAs: false });
      return { downloadId: id };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(i18n('errCannotSaveFile'));
}

async function dlState(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item) return { missing: true };
  return { state: item.state, error: item.error || null, filename: item.filename, fileSize: item.fileSize, exists: item.exists };
}

// ---------- Message routing ----------

const EXT_ORIGIN = chrome.runtime.getURL('');
// Content scripts in web pages may only use these commands, and only for their own tab
const CONTENT_COMMANDS = new Set(['getTabMedia', 'mediaCount', 'addDownload', 'openManager', 'getSettings']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'bg') return false;
  if (!sender?.url?.startsWith(EXT_ORIGIN)) {
    if (!CONTENT_COMMANDS.has(msg.cmd) || !sender?.tab) {
      sendResponse({ error: i18n('errNotAllowed') });
      return false;
    }
    msg = { ...msg, tabId: sender.tab.id, query: '' };
    if (msg.cmd === 'addDownload' && !/^https?:/i.test(String(msg.task?.url || ''))) {
      sendResponse({ error: i18n('errInvalidUrl') });
      return false;
    }
  }
  handle(msg, sender).then(
    (r) => sendResponse(r ?? { ok: true }),
    (e) => sendResponse({ error: String(e?.message || e) }),
  );
  return true;
});

async function handle(msg, sender) {
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.cmd) {
    // — from the UI / content scripts —
    case 'getSettings':
      return settings();
    case 'getTabMedia':
      if (tabId == null) return { entries: [] };
      return getMediaView(tabId);
    case 'mediaCount':
      return { count: tabId == null ? 0 : visibleCount(await getTabData(tabId)) };
    case 'clearTabMedia':
      await clearTab(tabId);
      return { ok: true };
    case 'addDownload':
      allowedTasks([msg.task]);
      return engine('add', { task: msg.task });
    case 'addDownloads': {
      const tasks = allowedTasks(msg.tasks);
      const r = await engine('add', { tasks });
      const skipped = (msg.tasks?.length || 0) - tasks.length;
      return skipped ? { ...r, skipped } : r;
    }
    case 'browserDownload': {
      let n = 0;
      for (const it of msg.items || []) {
        if (isVideoBlockedUrl(it.url)) continue;
        allowBrowserDownload(it.url);
        const opts = { url: it.url, conflictAction: 'uniquify', saveAs: false };
        if (it.filename) {
          opts.filename = [sanitizeSubpath(msg.dir || ''), sanitizeFilename(it.filename)].filter(Boolean).join('/');
          rememberFilename(it.url, opts.filename);
        }
        try {
          await chrome.downloads.download(opts);
          n++;
        } catch {
          try { await chrome.downloads.download({ url: it.url }); n++; } catch { /* skip */ }
        }
      }
      return { count: n };
    }
    case 'listTasks':
      return engine('list');
    case 'taskAction':
      return engine('action', { action: msg.action, ids: msg.ids, deleteFile: !!msg.deleteFile, filename: msg.filename });
    case 'savePage':
      return savePage(tabId, msg.format);
    case 'grabLinks':
      return grabLinks(tabId, { selection: !!msg.selection });
    case 'openManager':
      await openManager(msg.query || '');
      return { ok: true };
    case 'ensureEngine':
      await ensureEngine();
      return { ok: true };
    case 'uiLanguage':
      return { lang: chrome.i18n.getUILanguage() };

    // — from the download engine —
    case 'headers':
      await ensureHeaderRule(msg.url, msg.referer);
      return { ok: true };
    case 'save':
      return saveFile(msg);
    case 'dlState':
      return dlState(msg.id);
    case 'cancelDownload':
      await chrome.downloads.cancel(msg.id).catch(() => {});
      return { ok: true };
    case 'removeFile':
      await chrome.downloads.removeFile(msg.id).catch(() => {});
      await chrome.downloads.erase({ id: msg.id }).catch(() => {});
      return { ok: true };
    case 'notify':
      notify(msg.kind === 'error' ? i18n('notifyFailed') : i18n('notifyDone'), msg.message, `task:${msg.taskId}:${Date.now()}`);
      return { ok: true };
    case 'closeEngine':
      await chrome.offscreen.closeDocument().catch(() => {});
      return { ok: true };
    default:
      throw new Error(i18n('errUnknownCommand', msg.cmd));
  }
}
