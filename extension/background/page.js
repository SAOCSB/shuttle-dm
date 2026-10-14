// Saving pages (MHTML / HTML snapshot) and collecting a page's links for batch download.

import { db } from '../common/db.js';
import { uid, sanitizeFilename, hostOf } from '../common/util.js';
import { isVideoBlockedUrl } from '../common/sites.js';
import { i18n, uiLocale } from '../common/i18n.js';
import { engine } from './engine-client.js';

export async function importBlob(blob, meta) {
  const key = uid();
  await db.put('blobs', { key, blob });
  return engine('importBlob', { key, ...meta });
}

export async function savePage(tabId, format = 'mhtml') {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/i.test(tab.url || '')) throw new Error(i18n('errPageNotSavable'));
  const fallback = i18n('defaultPageName');
  const base = sanitizeFilename(tab.title || hostOf(tab.url) || fallback, fallback);
  let blob;
  let filename;
  if (format === 'mhtml') {
    blob = await captureMhtml(tabId);
    filename = `${base}.mhtml`;
  } else {
    const note = i18n('savedPageComment', new Date().toLocaleString(uiLocale()), tab.url);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: serializeDocument, args: [note] });
    if (!res?.result) throw new Error(i18n('errReadPage'));
    blob = new Blob([res.result], { type: 'text/html' });
    filename = `${base}.html`;
  }
  // Give an explicit MIME type, or the browser may sniff the content and rename .mhtml to .txt
  const mime = format === 'mhtml' ? 'multipart/related' : 'text/html';
  return importBlob(blob, { filename, sourceUrl: tab.url, title: tab.title, source: 'page', mime });
}

/**
 * Creates the MHTML. The Blob the browser returns is backed by a temporary file that is occasionally
 * deleted before it is read when the service worker is busy, so read it right away and retry up to 4 times.
 */
async function captureMhtml(tabId) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await chrome.pageCapture.saveAsMHTML({ tabId });
      if (!raw) throw new Error(i18n('errSavePageUnable'));
      const bytes = await raw.arrayBuffer();
      if (!bytes.byteLength) throw new Error(i18n('errPageEmpty'));
      return new Blob([bytes], { type: 'multipart/related' });
    } catch (e) {
      lastErr = e;
      if (/Cannot access|cannot be scripted|chrome:\/\//i.test(String(e?.message))) break;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error(i18n('errSavePageFailed', lastErr?.message || i18n('unknownReason')));
}

/** Runs in the page: a DOM snapshot without scripts that keeps form values and adds <base> so relative links work. */
function serializeDocument(note) {
  const srcFields = document.querySelectorAll('input, textarea, select');
  const clone = document.documentElement.cloneNode(true);
  const dstFields = clone.querySelectorAll('input, textarea, select');
  srcFields.forEach((el, i) => {
    const d = dstFields[i];
    if (!d) return;
    if (el.tagName === 'TEXTAREA') d.textContent = el.value;
    else if (el.tagName === 'SELECT') {
      [...d.options].forEach((o, k) => { if (el.options[k]?.selected) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked) d.setAttribute('checked', ''); else d.removeAttribute('checked');
    } else if (el.type !== 'password' && el.type !== 'file') d.setAttribute('value', el.value);
  });
  clone.querySelectorAll('script, #shuttle-dm-host').forEach((n) => n.remove());
  let head = clone.querySelector('head');
  if (!head) {
    head = document.createElement('head');
    clone.insertBefore(head, clone.firstChild);
  }
  head.querySelectorAll('meta[charset], meta[http-equiv="content-type" i]').forEach((m) => m.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  head.prepend(meta);
  if (!head.querySelector('base')) {
    const b = document.createElement('base');
    b.setAttribute('href', document.baseURI);
    meta.after(b);
  }
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`
    : '<!DOCTYPE html>';
  return `${doctype}\n<!-- ${String(note).replace(/--/g, '%2D%2D')} -->\n${clone.outerHTML}`;
}

/** Runs in the page: collects the addresses of links, images, audio and video. */
function collectLinks(selectionOnly) {
  const out = [];
  const seen = new Set();
  let inScope = () => true;
  if (selectionOnly) {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return [];
    const ranges = [];
    for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i));
    inScope = (el) => ranges.some((r) => r.intersectsNode(el));
  }
  const add = (raw, tag, text) => {
    if (!raw) return;
    let url;
    try { url = new URL(raw, document.baseURI).href; } catch { return; }
    if (!/^https?:/i.test(url)) return;
    url = url.replace(/#.*$/, '');
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, tag, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
  };
  const largestSrcset = (srcset) => {
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 0;
      if (u && w > bestW) { best = u; bestW = w; }
    }
    return best;
  };
  for (const a of document.querySelectorAll('a[href], area[href]')) {
    if (inScope(a)) add(a.getAttribute('href'), 'a', a.textContent || a.title || a.getAttribute('aria-label'));
  }
  for (const img of document.querySelectorAll('img')) {
    if (!inScope(img)) continue;
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
    const set = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    add((set && largestSrcset(set)) || lazy || img.currentSrc || img.src, 'img', img.alt || img.title);
  }
  for (const m of document.querySelectorAll('video, audio')) {
    if (!inScope(m)) continue;
    add(m.currentSrc || m.src, m.tagName.toLowerCase(), m.title);
    for (const s of m.querySelectorAll('source')) add(s.src, m.tagName.toLowerCase(), '');
    if (m.poster) add(m.poster, 'img', 'poster');
  }
  for (const e of document.querySelectorAll('embed[src], object[data]')) {
    if (inScope(e)) add(e.getAttribute('src') || e.getAttribute('data'), 'embed', '');
  }
  return out;
}

export async function grabLinks(tabId, { selection = false, frameId = null } = {}) {
  const target = selection && frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({ target, func: collectLinks, args: [!!selection] });
  const map = new Map();
  for (const r of results || []) {
    for (const it of r.result || []) {
      if (isVideoBlockedUrl(it.url)) continue;
      const old = map.get(it.url);
      if (!old) map.set(it.url, it);
      else if (!old.text && it.text) old.text = it.text;
    }
  }
  const tab = await chrome.tabs.get(tabId);
  // Keep only the two latest link lists so session storage does not fill up
  try {
    const all = await chrome.storage.session.get(null);
    const old = Object.entries(all)
      .filter(([k]) => k.startsWith('grab_'))
      .sort((x, y) => (y[1]?.time || 0) - (x[1]?.time || 0))
      .slice(1)
      .map(([k]) => k);
    if (old.length) await chrome.storage.session.remove(old);
  } catch { /* ignore */ }
  const key = 'grab_' + uid();
  await chrome.storage.session.set({
    [key]: { pageUrl: tab.url, title: tab.title, selection: !!selection, items: [...map.values()].slice(0, 5000), time: Date.now() },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/grab.html?key=${key}`), index: tab.index + 1, openerTabId: tabId });
  return { count: map.size };
}

export async function openManager(query = '') {
  const base = chrome.runtime.getURL('ui/manager.html');
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const hit = ctx.find((c) => c.documentUrl?.startsWith(base));
    if (hit) {
      await chrome.tabs.update(hit.tabId, { active: true, ...(query ? { url: base + query } : {}) });
      await chrome.windows.update(hit.windowId, { focused: true });
      return;
    }
  } catch { /* ignore */ }
  await chrome.tabs.create({ url: base + query });
}
