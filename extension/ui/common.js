// Shared UI helpers: messaging the background, engine progress, icons, the loom progress bar, toasts.

import { i18n } from '../common/i18n.js';

export async function bg(cmd, data = {}) {
  const r = await chrome.runtime.sendMessage({ to: 'bg', cmd, ...data });
  if (r && r.error) throw new Error(r.error);
  return r;
}

export function subscribe(fn) {
  const ch = new BroadcastChannel('shuttle-dm');
  ch.onmessage = (e) => fn(e.data);
  return ch;
}

const STATE_KEYS = {
  queued: 'stateQueued',
  downloading: 'stateDownloading',
  paused: 'statePaused',
  merging: 'stateMerging',
  saving: 'stateSaving',
  completed: 'stateCompleted',
  error: 'stateError',
};

/** Display names of task states (in the UI language) */
export const STATE_LABEL = new Proxy({}, { get: (_, k) => (STATE_KEYS[k] ? i18n(STATE_KEYS[k]) : undefined) });

const P = (d) => `<path d="${d}"/>`;
const ICONS = {
  download: P('M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14'),
  pause: P('M9 6v12M15 6v12'),
  play: P('M8 5.5v13l10.5-6.5z'),
  trash: P('M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7'),
  plus: P('M12 5v14M5 12h14'),
  sliders: P('M4 7h9M17 7h3M4 17h3M11 17h9') + '<circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  folder: P('M4 7a1.5 1.5 0 0 1 1.5-1.5H10l2 2h6.5A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z'),
  open: P('M14 4h6v6M20 4l-8 8M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'),
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/>' + P('M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5'),
  redo: P('M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4'),
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/>' + P('M15.5 10.5 20.5 7.5v9l-5-3'),
  audio: P('M9 17.5V6.5l10-2v11') + '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  stream: P('M12 4.5 20 8.5l-8 4-8-4zM4 12.5l8 4 8-4M4 16.5l8 4 8-4'),
  merge: P('M7 4.5v3a5 5 0 0 0 5 5 5 5 0 0 1 5 5v2M17 4.5v3a5 5 0 0 1-3 4.6M14.5 17l2.5 2.5 2.5-2.5'),
  page: P('M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12.5h6M9 15.5h6'),
  html: P('M9 8 5 12l4 4M15 8l4 4-4 4'),
  grab: P('M4 6h9M4 11h9M4 16h6M17.5 9v10m0 0-3-3m3 3 3-3'),
  record: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/>' + P('M19.5 19.5 15.5 15.5'),
  check: P('M5 12.5 9.5 17 19 7.5'),
  alert: '<circle cx="12" cy="12" r="8.5"/>' + P('M12 8v5M12 16v.5'),
  close: P('M6.5 6.5l11 11M17.5 6.5l-11 11'),
  manager: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>' + P('M3.5 9h17M7.5 12.5h9M7.5 15.5h6'),
  file: P('M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4'),
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/>' + P('M4 17l5-4.5 4 3.5 2.5-2 4.5 4'),
  archive: '<rect x="4" y="4" width="16" height="16" rx="2"/>' + P('M12 4v3m0 2v1m0 2v1M10.5 14h3v3h-3z'),
  program: '<rect x="3.5" y="5" width="17" height="14" rx="2"/>' + P('M3.5 9h17M7 13l2 1.5L7 16'),
  doc: P('M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6M9 15h6M9 18h3'),
  globe: '<circle cx="12" cy="12" r="8.5"/>' + P('M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17'),
  list: P('M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.5M4 12h.5M4 17.5h.5'),
  speed: P('M4.5 16a7.5 7.5 0 1 1 15 0M12 16l3.5-5'),
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="7" fill="#1E2B4F"/>
  <path d="M5 8h22M5 11.5h22M5 15h22" stroke="#2F3F6E" stroke-width="0.9"/>
  <path d="M13.6 4.5h4.8v10.4h4.9L16 22.4 8.7 14.9h4.9z" fill="#fff"/>
  <path d="M6 26.3l3.5-2.4h13l3.5 2.4-3.5 2.4h-13z" fill="#F08C00"/>
</svg>`;

/** Tiny DOM builder: string children are inserted as text, never as HTML */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastHost = null;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast ${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 5000 : 2600);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Draws the “loom” progress bar: woven parts in indigo, active connections marked with saffron shuttles.
 * @param canvas
 * @param o.map    completion of 100 cells (0–1), optional
 * @param o.ratio  overall progress (0–1) when there is no map
 * @param o.conns  active connections [{start,pos,end}]
 * @param o.size   total file size
 * @param o.state  task state
 */
export function drawLoom(canvas, o = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const woven = o.state === 'completed' ? cssVar('--done') : o.state === 'error' ? cssVar('--error') : cssVar('--woven');
  const thread = cssVar('--thread');
  if (o.state === 'completed') {
    ctx.fillStyle = woven;
    ctx.fillRect(0, 0, w, hgt);
    return;
  }
  if (o.map && o.map.length) {
    const n = o.map.length;
    const bw = w / n;
    ctx.fillStyle = woven;
    for (let i = 0; i < n; i++) {
      const f = o.map[i];
      if (f <= 0) continue;
      ctx.globalAlpha = f >= 1 ? 1 : 0.35 + f * 0.5;
      ctx.fillRect(Math.floor(i * bw), 0, Math.ceil(bw) + 0.5, hgt);
    }
    ctx.globalAlpha = 1;
  } else if (o.ratio != null) {
    ctx.fillStyle = woven;
    ctx.fillRect(0, 0, Math.max(0, Math.min(1, o.ratio)) * w, hgt);
  }
  if (o.conns?.length && o.size) {
    ctx.fillStyle = thread;
    for (const c of o.conns) {
      const x = (c.pos / o.size) * w;
      const sw = Math.max(2, Math.min(5, hgt * 0.35));
      ctx.fillRect(Math.max(0, x - sw / 2), 0, sw, hgt);
    }
  } else if (o.state === 'downloading' && o.ratio != null && !o.map) {
    ctx.fillStyle = thread;
    const x = Math.max(0, Math.min(1, o.ratio)) * w;
    ctx.fillRect(Math.max(0, x - 1.5), 0, 3, hgt);
  }
}

/** One “weft” line per connection: the line is the whole file, saffron is what that connection finished, the shuttle is where it is now */
export function drawThreads(canvas, conns, size) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const rowH = 12;
  const hgt = Math.max(rowH, conns.length * rowH);
  canvas.style.height = hgt + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const warp = cssVar('--warp');
  const thread = cssVar('--thread');
  const ink = cssVar('--woven');
  conns.forEach((c, i) => {
    const y = i * rowH + rowH / 2;
    ctx.fillStyle = warp;
    ctx.fillRect(0, y - 0.5, w, 1);
    const x0 = (c.start / size) * w;
    const x1 = ((c.end ?? size) / size) * w;
    const xp = (c.pos / size) * w;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x0, y - 1.5, Math.max(1, x1 - x0), 3);
    ctx.globalAlpha = 1;
    ctx.fillStyle = thread;
    ctx.fillRect(x0, y - 1.5, Math.max(1, xp - x0), 3);
    // The shuttle: a small diamond pointed at both ends
    ctx.beginPath();
    ctx.moveTo(xp - 6, y);
    ctx.lineTo(xp - 3, y - 3.5);
    ctx.lineTo(xp + 3, y - 3.5);
    ctx.lineTo(xp + 6, y);
    ctx.lineTo(xp + 3, y + 3.5);
    ctx.lineTo(xp - 3, y + 3.5);
    ctx.closePath();
    ctx.fill();
  });
}

export function categoryIcon(cat) {
  return { video: 'video', audio: 'audio', document: 'doc', archive: 'archive', program: 'program', image: 'image', page: 'globe' }[cat] || 'file';
}

export async function activeTab() {
  const q = new URLSearchParams(location.search);
  if (q.get('tabId')) {
    const id = Number(q.get('tabId'));
    try { return await chrome.tabs.get(id); } catch { return { id }; }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
