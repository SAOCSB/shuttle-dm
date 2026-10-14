// Content script: shows a “Download video” button in the corner of a web video on hover, and lists the detected streams when clicked.
(() => {
  // Don't run on sites where video downloading is switched off (same list as common/sites.js)
  const pageHost = location.hostname.toLowerCase();
  if (['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'googlevideo.com'].some((d) => pageHost === d || pageHost.endsWith('.' + d))) return;

  // The script is injected again after an update: if the old instance is orphaned (its extension context is gone), remove its UI and take over
  const prev = window.__shuttleDM;
  if (prev && typeof prev.alive === 'function' && prev.alive()) return;
  try { prev?.destroy?.(); } catch { /* ignore */ }
  const myChrome = chrome;
  const cleanups = [];
  window.__shuttleDM = {
    alive: () => { try { return !!myChrome.runtime?.id; } catch { return false; } },
    destroy: () => { for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } } },
  };

  const MIN_W = 220;
  const MIN_H = 120;

  // UI text (_locales/*/messages.json)
  function i18n(key, ...subs) {
    try {
      return myChrome.i18n.getMessage(key, subs.map(String)) || key;
    } catch {
      return key;
    }
  }
  let enabled = true;
  let mediaCount = 0;
  const videos = new Set();
  const dismissed = new WeakSet();

  // ---------- Settings ----------
  try {
    chrome.storage.local.get('settings').then(({ settings }) => {
      enabled = settings?.showOverlay !== false;
    }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.settings) {
        enabled = ch.settings.newValue?.showOverlay !== false;
        if (!enabled) hideAll();
      }
    });
  } catch { /* the extension was reloaded */ }

  function alive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function send(cmd, data = {}) {
    if (!alive()) return Promise.reject(new Error(i18n('extensionUpdated')));
    return chrome.runtime.sendMessage({ to: 'bg', cmd, ...data }).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r;
    });
  }

  // ---------- Finding videos ----------
  function scan() {
    for (const v of document.getElementsByTagName('video')) videos.add(v);
  }
  scan();
  let scanTimer = 0;
  const mo = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 800);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  cleanups.push(() => mo.disconnect());

  // ---------- UI ----------
  let host = null;
  let root = null;
  let pill = null;
  let panel = null;
  let current = null;
  let hideTimer = 0;
  let panelOpen = false;
  let overUi = false;

  const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M5.5 19.5h13" stroke="#F08C00"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #1b2337; }
    .wrap:lang(ja) { font-family: system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", Meiryo, "Noto Sans CJK JP", sans-serif; }
    .wrap:lang(ko) { font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", sans-serif; }
    .pill { display: inline-flex; align-items: center; gap: 2px; height: 30px; border-radius: 15px; background: rgba(30, 43, 79, .94);
      color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); overflow: hidden; backdrop-filter: blur(6px); animation: in .16s ease-out; }
    .pill button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 30px; color: inherit; }
    .pill .go { padding: 0 6px 0 11px; font-weight: 600; }
    .pill .go:hover { background: rgba(255,255,255,.12); }
    .pill .go svg { width: 16px; height: 16px; }
    .pill .n { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #F08C00; color: #fff; font-size: 11px;
      display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
    .pill .n[hidden] { display: none; }
    .pill .x { width: 26px; justify-content: center; opacity: .7; border-left: 1px solid rgba(255,255,255,.18); }
    .pill .x:hover { opacity: 1; background: rgba(255,255,255,.12); }
    .pill .x svg { width: 13px; height: 13px; }
    .panel { width: 340px; max-height: min(420px, 70vh); display: flex; flex-direction: column; background: #fff; border-radius: 10px;
      border: 1px solid #dce1ec; box-shadow: 0 10px 34px rgba(16, 23, 42, .32); overflow: hidden; animation: in .16s ease-out; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: #1e2b4f; color: #fff; }
    .head b { font-size: 13px; font-weight: 600; }
    .head button { all: unset; cursor: pointer; font-size: 12px; opacity: .85; }
    .head button:hover { opacity: 1; text-decoration: underline; }
    .list { overflow-y: auto; }
    .row { padding: 10px 12px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .row + .row { border-top: 1px solid #eceff5; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { display: flex; gap: 9px; align-items: center; color: #5b6583; font-size: 12px; flex-wrap: wrap; }
    .tag { border: 1px solid #dce1ec; border-radius: 3px; padding: 0 4px; font-size: 11px; font-weight: 600; color: #5b6583; }
    .note { font-size: 12px; color: #5b6583; }
    .note.warn { color: #c2412d; }
    .act { display: flex; gap: 6px; }
    select { flex: 1; min-width: 0; height: 28px; border: 1px solid #dce1ec; border-radius: 4px; background: #fff; color: #1b2337; font: inherit; font-size: 12.5px; padding: 0 6px; }
    .btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 12px;
      border-radius: 4px; background: #1e2b4f; color: #fff; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
    .btn:hover { background: #26365f; }
    .btn[disabled] { opacity: .45; pointer-events: none; }
    .btn.ghost { background: transparent; color: #1e2b4f; border: 1px solid #dce1ec; font-weight: 500; }
    .btn svg { width: 15px; height: 15px; }
    .empty, .loading { padding: 16px 14px; color: #5b6583; font-size: 12.5px; line-height: 1.7; }
    .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; border-top: 1px solid #eceff5; font-size: 12px; color: #5b6583; }
    .foot button { all: unset; cursor: pointer; color: #2f4580; white-space: nowrap; flex: none; }
    .foot button:hover { text-decoration: underline; }
    .toast { padding: 7px 12px; border-radius: 8px; background: rgba(30,43,79,.96); color: #fff; font-size: 12.5px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
    .toast.err { background: #c2412d; }
    @keyframes in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .pill, .panel { animation: none; } }
    @media (prefers-color-scheme: dark) {
      .panel { background: #161f36; border-color: #2a3555; color: #e4e8f2; }
      .wrap { color: #e4e8f2; }
      .head { background: #0c1324; }
      .row + .row, .foot { border-color: #212b47; }
      .meta, .note, .empty, .loading, .foot { color: #a1aac4; }
      .tag { border-color: #2a3555; color: #a1aac4; }
      select { background: #1c2642; color: #e4e8f2; border-color: #2a3555; }
      .btn { background: #7895ec; color: #0c1324; }
      .btn:hover { background: #8aa6ff; }
      .btn.ghost { color: #c9d4f5; border-color: #2a3555; background: transparent; }
      .foot button { color: #9db2f2; }
    }`;

  function ensureUi() {
    if (host) return;
    host = document.createElement('shuttle-dm-overlay');
    host.id = 'shuttle-dm-host';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.lang = i18n('localeTag');
    wrap.style.display = 'none';
    root.append(style, wrap);
    pill = document.createElement('div');
    pill.className = 'pill';
    const go = document.createElement('button');
    go.className = 'go';
    go.type = 'button';
    go.innerHTML = ICON_DL;
    go.append(document.createTextNode(i18n('overlayDownload')));
    const n = document.createElement('span');
    n.className = 'n';
    n.hidden = true;
    go.append(n);
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.title = i18n('overlayHide');
    x.innerHTML = ICON_X;
    pill.append(go, x);
    wrap.append(pill);
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (current) dismissed.add(current);
      hideAll();
    });
    wrap.addEventListener('pointerenter', () => { overUi = true; clearTimeout(hideTimer); });
    wrap.addEventListener('pointerleave', () => { overUi = false; scheduleHide(); });
    // Keep clicks from reaching the page (so the player doesn't pause, seek, etc.)
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']) {
      wrap.addEventListener(type, (e) => e.stopPropagation());
    }
    attachHost();
    updateCount();
    cleanups.push(() => host?.remove());
  }

  function wrapEl() {
    return root?.querySelector('.wrap');
  }

  function attachHost() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
  }

  document.addEventListener('fullscreenchange', () => {
    if (!host) return;
    attachHost();
    if (current) position();
  });

  function updateCount() {
    const n = root?.querySelector('.n');
    if (!n) return;
    n.textContent = String(mediaCount);
    n.hidden = !mediaCount;
  }

  function position() {
    const w = wrapEl();
    if (!w || !current) return;
    const r = current.getBoundingClientRect();
    const top = Math.max(6, Math.min(r.top + 10, innerHeight - 40));
    const right = Math.max(6, innerWidth - r.right + 10);
    w.style.top = `${top}px`;
    w.style.right = `${right}px`;
    w.style.left = 'auto';
  }

  let countAsked = false;
  function show(v) {
    if (!countAsked) {
      countAsked = true;
      send('mediaCount').then((r) => { mediaCount = r?.count || 0; updateCount(); }).catch(() => {});
    }
    ensureUi();
    clearTimeout(hideTimer);
    if (current !== v) closePanel();
    current = v;
    attachHost();
    wrapEl().style.display = 'flex';
    position();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (panelOpen || overUi) return;
    hideTimer = setTimeout(() => {
      if (!panelOpen && !overUi) hideAll(false);
    }, 1600);
  }

  function hideAll(resetCurrent = true) {
    closePanel();
    const w = wrapEl();
    if (w) w.style.display = 'none';
    if (resetCurrent) current = null;
  }

  // Videos are often covered by transparent overlays, so hit-test by position instead of relying on the event target
  let raf = 0;
  let lastX = 0;
  let lastY = 0;
  addEventListener('pointermove', (e) => {
    if (!enabled || !videos.size) return;
    if (!alive()) { window.__shuttleDM?.destroy?.(); enabled = false; return; }
    lastX = e.clientX;
    lastY = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      hitTest(lastX, lastY);
    });
  }, { capture: true, passive: true });

  function hitTest(x, y) {
    let hit = null;
    for (const v of videos) {
      if (!v.isConnected) { videos.delete(v); continue; }
      if (dismissed.has(v)) continue;
      const r = v.getBoundingClientRect();
      if (r.width < MIN_W || r.height < MIN_H) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { hit = v; break; }
    }
    if (hit) show(hit);
    else if (current && !panelOpen && !overUi) scheduleHide();
  }

  addEventListener('scroll', () => { if (current && wrapEl()?.style.display !== 'none') position(); }, { capture: true, passive: true });
  addEventListener('resize', () => { if (current) position(); }, { passive: true });

  // ---------- Panel ----------
  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function closePanel() {
    panel?.remove();
    panel = null;
    panelOpen = false;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function toast(msg, err = false) {
    ensureUi();
    const t = el('div', `toast${err ? ' err' : ''}`, msg);
    wrapEl().append(t);
    if (wrapEl().style.display === 'none') {
      wrapEl().style.display = 'flex';
      wrapEl().style.top = '16px';
      wrapEl().style.right = '16px';
    }
    setTimeout(() => t.remove(), err ? 4200 : 2200);
  }

  async function openPanel() {
    ensureUi();
    closePanel();
    panelOpen = true;
    panel = el('div', 'panel');
    const head = el('div', 'head');
    head.append(el('b', '', i18n('panelTitle')));
    const mgr = el('button', '', i18n('panelManager'));
    mgr.type = 'button';
    mgr.onclick = () => send('openManager').catch(() => {});
    head.append(mgr);
    const list = el('div', 'list');
    list.append(el('div', 'loading', i18n('detecting')));
    const foot = el('div', 'foot');
    foot.append(el('span', '', i18n('panelHint')));
    const close = el('button', '', i18n('close'));
    close.type = 'button';
    close.onclick = closePanel;
    foot.append(close);
    panel.append(head, list, foot);
    wrapEl().append(panel);
    let entries = [];
    try {
      const view = await send('getTabMedia');
      entries = view.entries || [];
    } catch (e) {
      list.replaceChildren(el('div', 'empty', String(e.message || e)));
      return;
    }
    const src = current?.currentSrc || current?.src || '';
    if (/^https?:/i.test(src) && !entries.some((x) => x.url === src)) {
      let name = src.split(/[?#]/)[0].split('/').pop() || 'video';
      try { name = decodeURIComponent(name); } catch { /* keep as is */ }
      entries.unshift({
        kind: 'video', title: name, meta: [i18n('currentVideo')],
        action: 'download', url: src,
        params: { type: 'http', url: src, referer: location.href, pageUrl: location.href, pageTitle: document.title },
      });
    }
    if (!panel) return;
    list.replaceChildren();
    if (!entries.length) {
      list.append(el('div', 'empty', i18n('panelEmpty')));
      return;
    }
    for (const e of entries) list.append(renderEntry(e));
  }

  function renderEntry(e) {
    const row = el('div', 'row');
    const title = el('div', 'title', e.title);
    title.title = e.title;
    row.append(title);
    const meta = el('div', 'meta');
    (e.meta || []).forEach((m, i) => meta.append(el('span', i === 0 ? 'tag' : '', m)));
    row.append(meta);
    if (e.note) row.append(el('div', `note${e.warn ? ' warn' : ''}`, e.note));
    const act = el('div', 'act');
    let select = null;
    if (e.choices?.length) {
      select = el('select');
      e.choices.forEach((c, i) => {
        const o = el('option', '', c.label);
        o.value = String(i);
        select.append(o);
      });
      act.append(select);
    } else {
      act.append(el('span', '', ''));
      act.firstChild.style.flex = '1';
    }
    const label = i18n(e.action === 'record' ? 'actionRecord' : e.action === 'copy' ? 'actionCopyLink' : 'actionDownload');
    const btn = el('button', `btn${e.action === 'copy' ? ' ghost' : ''}`);
    btn.type = 'button';
    if (e.action !== 'copy') btn.innerHTML = ICON_DL;
    btn.append(document.createTextNode(label));
    if (e.disabled) btn.setAttribute('disabled', '');
    btn.onclick = async () => {
      if (e.action === 'copy') {
        try { await navigator.clipboard.writeText(e.url); toast(i18n('linkCopied')); } catch { toast(i18n('copyFailed'), true); }
        return;
      }
      const params = select ? e.choices[Number(select.value)].params : e.params;
      btn.setAttribute('disabled', '');
      try {
        const r = await send('addDownload', { task: params });
        toast(i18n(r.ids?.length ? (e.action === 'record' ? 'recordStarted' : 'downloadStarted') : 'alreadyInList'));
        closePanel();
      } catch (err) {
        toast(String(err.message || err), true);
      } finally {
        btn.removeAttribute('disabled');
      }
    };
    act.append(btn);
    row.append(act);
    return row;
  }

  // ---------- Messages from the background ----------
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.to !== 'content') return false;
      if (msg.cmd === 'media') {
        mediaCount = msg.count || 0;
        updateCount();
      } else if (msg.cmd === 'showPanel') {
        let best = null;
        let area = 0;
        for (const v of videos) {
          const r = v.getBoundingClientRect();
          if (r.width * r.height > area && r.bottom > 0 && r.top < innerHeight) { best = v; area = r.width * r.height; }
        }
        if (best) show(best);
        else {
          ensureUi();
          current = null;
          wrapEl().style.display = 'flex';
          wrapEl().style.top = '16px';
          wrapEl().style.right = '16px';
        }
        openPanel();
      }
      return false;
    });
  } catch { /* ignore */ }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) closePanel();
  }, true);
})();
