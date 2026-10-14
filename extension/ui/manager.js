import { bg, subscribe, icon, LOGO, h, toast, drawLoom, drawThreads, STATE_LABEL, categoryIcon } from './common.js';
import { formatBytes, formatSpeed, formatEta, formatTime, formatDuration, categoryOf, CATEGORY_LIST, hostOf } from '../common/util.js';
import { getSettings } from '../common/settings.js';
import { i18n, tp, uiLocale, localizePage } from '../common/i18n.js';

const $ = (id) => document.getElementById(id);
const tasks = new Map();
const rows = new Map();
let selected = new Set();
let anchor = null;
let visible = [];
let query = '';
let settings = null;
let filter = load('filter', { kind: 'state', value: 'all' });
let sort = load('sort', { key: 'time', dir: 'desc' });

function load(k, d) {
  try { return JSON.parse(localStorage.getItem('sdm.' + k)) ?? d; } catch { return d; }
}
function save(k, v) {
  try { localStorage.setItem('sdm.' + k, JSON.stringify(v)); } catch { /* ignore */ }
}

const ACTIVE = ['queued', 'downloading', 'merging', 'saving'];
const STATE_FILTERS = [
  { value: 'all', label: 'filterAll', icon: 'list', test: () => true },
  { value: 'active', label: 'filterActive', icon: 'download', test: (t) => ACTIVE.includes(t.state) },
  { value: 'done', label: 'filterDone', icon: 'check', test: (t) => t.state === 'completed' },
  { value: 'unfinished', label: 'filterUnfinished', icon: 'pause', test: (t) => t.state === 'paused' || t.state === 'error' },
];

const catOf = (t) => categoryOf(t.filename, t.mime);

// ---------- Layout ----------

function withIcon(el, ico, key) {
  el.innerHTML = ico ? icon(ico) : '';
  el.append(h('span', {}, i18n(key)));
}

function setupChrome() {
  localizePage();
  $('brand').insertAdjacentHTML('afterbegin', LOGO);
  withIcon($('btnNew'), 'plus', 'newTask');
  withIcon($('btnResume'), 'play', 'resume');
  withIcon($('btnPause'), 'pause', 'pause');
  withIcon($('btnDelete'), 'trash', 'delete');
  withIcon($('btnResumeAll'), null, 'resumeAll');
  withIcon($('btnPauseAll'), null, 'pauseAll');
  $('searchIcon').outerHTML = icon('search');
  $('btnFolder').innerHTML = icon('folder');
  $('btnSettings').innerHTML = icon('sliders');

  $('btnNew').onclick = () => openNewDialog();
  $('btnResume').onclick = () => act('resume', [...selected]);
  $('btnPause').onclick = () => act('pause', [...selected]);
  $('btnDelete').onclick = () => openDeleteDialog([...selected]);
  $('btnResumeAll').onclick = () => act('resumeAll', []);
  $('btnPauseAll').onclick = () => act('pauseAll', []);
  $('btnFolder').onclick = () => chrome.downloads.showDefaultFolder();
  $('clearDone').onclick = () => {
    act('clearCompleted', []);
    toast(i18n('clearedCompleted'));
  };
  $('btnSettings').onclick = () => chrome.runtime.openOptionsPage();
  $('search').oninput = (e) => {
    query = e.target.value.trim().toLowerCase();
    renderList();
  };
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' };
      save('sort', sort);
      renderList();
    };
  });
}

function renderNav() {
  const all = [...tasks.values()];
  const doneCount = all.filter((t) => t.state === 'completed').length;
  const clear = $('clearDone');
  clear.classList.toggle('hidden', !doneCount);
  clear.textContent = tp('clearCompletedN', doneCount);
  const stateNav = $('stateNav');
  stateNav.replaceChildren(
    ...STATE_FILTERS.map((f) => navItem(i18n(f.label), f.icon, all.filter(f.test).length, filter.kind === 'state' && filter.value === f.value, () => setFilter({ kind: 'state', value: f.value }))),
  );
  $('catNav').replaceChildren(
    ...CATEGORY_LIST.map((c) => navItem(c.name, categoryIcon(c.id), all.filter((t) => catOf(t) === c.id).length, filter.kind === 'cat' && filter.value === c.id, () => setFilter({ kind: 'cat', value: c.id }))),
  );
}

function navItem(label, ico, n, active, onclick) {
  const b = h('button', { class: `nav-item${active ? ' active' : ''}`, 'aria-current': active ? 'true' : null, html: icon(ico) });
  b.append(h('span', {}, label), h('span', { class: 'n data' }, n ? String(n) : ''));
  b.onclick = onclick;
  return b;
}

function setFilter(f) {
  filter = f;
  save('filter', f);
  renderNav();
  renderList();
}

function matches(t) {
  if (filter.kind === 'state') {
    const f = STATE_FILTERS.find((x) => x.value === filter.value) || STATE_FILTERS[0];
    if (!f.test(t)) return false;
  } else if (catOf(t) !== filter.value) return false;
  if (query) {
    const hay = `${t.filename} ${t.url} ${t.pageTitle || ''}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}

function sorted(list) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = sort.key;
  return list.sort((a, b) => {
    let r = 0;
    if (key === 'name') r = a.filename.localeCompare(b.filename, uiLocale());
    else if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else r = a.createdAt - b.createdAt;
    return r * dir;
  });
}

// ---------- List ----------

function renderList() {
  const list = sorted([...tasks.values()].filter(matches));
  visible = list.map((t) => t.id);
  const tbody = $('rows');
  const keep = new Set(visible);
  for (const [id, r] of rows) if (!keep.has(id)) { r.tr.remove(); rows.delete(id); }
  let prev = null;
  for (const t of list) {
    let r = rows.get(t.id);
    if (!r) {
      r = buildRow(t);
      rows.set(t.id, r);
    }
    updateRow(r, t);
    const expectedNext = prev ? prev.nextSibling : tbody.firstChild;
    if (expectedNext !== r.tr) tbody.insertBefore(r.tr, expectedNext);
    prev = r.tr;
  }
  selected = new Set([...selected].filter((id) => tasks.has(id)));
  for (const [id, r] of rows) r.tr.classList.toggle('sel', selected.has(id));
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.querySelector('.arrow')?.remove();
    if (th.dataset.sort === sort.key) th.append(h('span', { class: 'arrow' }, sort.dir === 'asc' ? '↑' : '↓'));
  });
  renderEmpty(list.length);
  updateToolbar();
  renderDetail();
  requestAnimationFrame(redrawLooms);
}

function redrawLooms() {
  for (const [id, r] of rows) {
    const t = tasks.get(id);
    if (t) drawLoom(r.canvas, loomOpts(t));
  }
}

function renderEmpty(n) {
  const empty = $('empty');
  empty.classList.toggle('hidden', n > 0);
  if (n > 0) return;
  empty.replaceChildren();
  if (tasks.size === 0) {
    const btn = h('button', { class: 'btn btn-primary', html: icon('plus') }, i18n('newTask'));
    btn.onclick = () => openNewDialog();
    empty.append(
      h('strong', {}, i18n('emptyListTitle')),
      i18n('emptyListBody'),
      h('div', {}, btn),
    );
  } else {
    empty.append(h('strong', {}, i18n('noMatchTitle')), query ? i18n('noMatchQuery', query) : i18n('noMatchCategory'));
  }
}

function buildRow(t) {
  const tr = h('tr', { tabindex: '-1', dataset: { id: t.id } });
  const fico = h('div', { class: 'fico' });
  const fname = h('div', { class: 'fname ellipsis' });
  const sub = h('div', { class: 'sub ellipsis' });
  const size = h('span', { class: 'num data' });
  const canvas = h('canvas', { class: 'loom' });
  const pct = h('span', { class: 'pct data' });
  const pstate = h('span', { class: 'pstate' });
  const speed = h('span', { class: 'num data' });
  const eta = h('span', { class: 'num' });
  const time = h('span', { class: 'num data dim' });
  tr.append(
    h('td', {}, h('div', { class: 'name-cell' }, fico, h('div', { class: 'name-text' }, fname, sub))),
    h('td', {}, size),
    h('td', {}, h('div', { class: 'prog' }, canvas, pstate, pct)),
    h('td', {}, speed),
    h('td', {}, eta),
    h('td', {}, time),
  );
  tr.addEventListener('click', (e) => onRowClick(e, t.id));
  tr.addEventListener('dblclick', () => onRowDouble(t.id));
  tr.addEventListener('contextmenu', (e) => onContext(e, t.id));
  return { tr, fico, fname, sub, size, canvas, pct, pstate, speed, eta, time, cat: null };
}

function pctOf(t) {
  if (t.state === 'merging' && t.merge != null) return Math.floor(t.merge * 100);
  if (!t.size) return null;
  return Math.min(100, Math.floor((t.received / t.size) * 100));
}

function stateText(t) {
  if (t.state === 'downloading' && t.hls?.live) return i18n('stateRecording');
  return STATE_LABEL[t.state] || t.state;
}

function subText(t) {
  if (t.state === 'error' && t.error) return { text: t.error, cls: 'err' };
  if (t.note) return { text: t.note, cls: 'note' };
  if (t.type === 'hls') {
    const parts = ['HLS'];
    if (t.hls?.quality) parts.push(t.hls.quality);
    if (t.hls?.live && t.hls.doneDuration != null) parts.push(i18n('subRecorded', formatDuration(t.hls.doneDuration)));
    else if (t.hls?.total) parts.push(i18n('subSegments', t.hls.done, t.hls.total));
    return { text: i18n('subWithHost', parts.join(' '), hostOf(t.url)), cls: '' };
  }
  if (t.type === 'merge') return { text: i18n('subMerge', hostOf(t.url)), cls: '' };
  if (t.source === 'page') return { text: i18n('subSavedPage', hostOf(t.url)), cls: '' };
  return { text: hostOf(t.url) || t.url, cls: '' };
}

function loomOpts(t) {
  return {
    map: t.state === 'downloading' ? t.map : null,
    conns: t.state === 'downloading' ? t.conns : null,
    size: t.size,
    state: t.state,
    ratio: t.state === 'merging' ? t.merge ?? 0 : t.size ? t.received / t.size : t.state === 'completed' ? 1 : null,
  };
}

function updateRow(r, t) {
  r.tr.dataset.state = t.state;
  const cat = catOf(t);
  if (r.cat !== cat) {
    r.fico.innerHTML = icon(categoryIcon(cat));
    r.cat = cat;
  }
  r.fname.textContent = t.filename;
  r.fname.title = t.filename;
  const s = subText(t);
  r.sub.textContent = s.text;
  r.sub.title = s.text;
  r.sub.className = `sub ellipsis ${s.cls}`;
  const est = t.type === 'hls' && t.state === 'downloading' && t.size;
  r.size.textContent = t.size ? (est ? i18n('approxSize', formatBytes(t.size)) : formatBytes(t.size)) : t.received ? formatBytes(t.received) : '—';
  const p = pctOf(t);
  r.pct.textContent = t.state === 'completed' ? '' : p != null ? `${p}%` : t.state === 'downloading' ? formatBytes(t.received) : '';
  r.pstate.textContent = stateText(t);
  const downloading = t.state === 'downloading';
  r.speed.textContent = downloading ? formatSpeed(t.speed) : '—';
  r.speed.classList.toggle('dim', !downloading);
  r.eta.textContent = downloading && !t.hls?.live ? formatEta(t.eta) : '—';
  r.eta.classList.toggle('dim', !downloading);
  r.time.textContent = formatTime(t.createdAt);
  drawLoom(r.canvas, loomOpts(t));
}

// ---------- Selection and actions ----------

function onRowClick(e, id) {
  if (e.shiftKey && anchor && visible.includes(anchor)) {
    const a = visible.indexOf(anchor);
    const b = visible.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selected = new Set(visible.slice(lo, hi + 1));
  } else if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = id;
  } else {
    selected = new Set([id]);
    anchor = id;
  }
  for (const [rid, r] of rows) r.tr.classList.toggle('sel', selected.has(rid));
  updateToolbar();
  renderDetail();
}

function onRowDouble(id) {
  const t = tasks.get(id);
  if (!t) return;
  if (t.state === 'completed') openFile(t);
  else if (t.state === 'downloading' || t.state === 'queued') act('pause', [id]);
  else if (t.state === 'paused' || t.state === 'error') act('resume', [id]);
}

function updateToolbar() {
  const sel = [...selected].map((id) => tasks.get(id)).filter(Boolean);
  $('btnResume').disabled = !sel.some((t) => t.state === 'paused' || t.state === 'error');
  $('btnPause').disabled = !sel.some((t) => t.state === 'downloading' || t.state === 'queued');
  $('btnDelete').disabled = !sel.length;
}

async function act(action, ids, extra = {}) {
  try {
    await bg('taskAction', { action, ids, ...extra });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openFile(t) {
  if (t.downloadId == null) return toast(i18n('fileRecordMissing'), 'error');
  chrome.downloads.open(t.downloadId)?.catch?.(() => toast(i18n('fileMissing'), 'error'));
}

function showFile(t) {
  if (t.downloadId == null) return chrome.downloads.showDefaultFolder();
  try {
    chrome.downloads.show(t.downloadId);
  } catch {
    chrome.downloads.showDefaultFolder();
  }
}

async function copy(text, msg = i18n('linkCopied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    toast(i18n('copyFailed'), 'error');
  }
}

// ---------- Context menu ----------

function onContext(e, id) {
  e.preventDefault();
  if (!selected.has(id)) {
    selected = new Set([id]);
    anchor = id;
    for (const [rid, r] of rows) r.tr.classList.toggle('sel', selected.has(rid));
    updateToolbar();
    renderDetail();
  }
  const sel = [...selected].map((x) => tasks.get(x)).filter(Boolean);
  const one = sel.length === 1 ? sel[0] : null;
  const items = [];
  if (one?.state === 'completed') {
    items.push(['open', i18n('openFile'), () => openFile(one)]);
    items.push(['folder', i18n('showInFolder'), () => showFile(one)]);
    items.push('-');
  }
  if (sel.some((t) => t.state === 'paused' || t.state === 'error')) items.push(['play', i18n('resume'), () => act('resume', sel.map((t) => t.id))]);
  if (sel.some((t) => t.hls?.live && t.state === 'downloading')) items.push(['stop', i18n('stopRecording'), () => act('stop', sel.map((t) => t.id))]);
  else if (sel.some((t) => t.state === 'downloading' || t.state === 'queued')) items.push(['pause', i18n('pause'), () => act('pause', sel.map((t) => t.id))]);
  if (one) {
    items.push(['copy', i18n('copyDownloadLink'), () => copy(one.url)]);
    if (one.pageUrl) items.push(['globe', i18n('openSourcePage'), () => chrome.tabs.create({ url: one.pageUrl })]);
  }
  const redo = sel.filter((t) => (t.state === 'completed' || t.state === 'error') && t.type !== 'blob');
  if (redo.length) items.push(['redo', i18n('redownload'), () => act('redownload', redo.map((t) => t.id))]);
  items.push('-');
  items.push(['trash', sel.length > 1 ? tp('deleteN', sel.length) : i18n('delete'), () => openDeleteDialog(sel.map((t) => t.id)), 'danger']);
  const menu = $('ctx');
  menu.replaceChildren();
  for (const it of items) {
    if (it === '-') {
      if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.append(h('hr'));
      continue;
    }
    const [ico, label, fn, cls] = it;
    const b = h('button', { role: 'menuitem', class: cls || '', html: icon(ico) });
    b.append(label);
    b.onclick = () => { hideContext(); fn(); };
    menu.append(b);
  }
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.min(e.clientX, innerWidth - mw - 6)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - mh - 6)}px`;
  menu.querySelector('button')?.focus();
}

function hideContext() {
  $('ctx').classList.add('hidden');
}

document.addEventListener('click', (e) => { if (!$('ctx').contains(e.target)) hideContext(); });
window.addEventListener('blur', hideContext);

// ---------- Details ----------

let detailId = null;
let detailRefs = null;

function renderDetail() {
  const box = $('detail');
  const one = selected.size === 1 ? tasks.get([...selected][0]) : null;
  if (!one) {
    box.classList.add('hidden');
    detailId = null;
    detailRefs = null;
    return;
  }
  box.classList.remove('hidden');
  detailId = one.id;
  const t = one;
  const actions = h('div', { class: 'd-actions' });
  const btn = (ico, label, fn, primary = false) => {
    const b = h('button', { class: `btn ${primary ? 'btn-primary' : ''}`, html: icon(ico) });
    b.append(label);
    b.onclick = fn;
    actions.append(b);
  };
  if (t.state === 'completed') {
    btn('open', i18n('openFile'), () => openFile(t), true);
    btn('folder', i18n('showInFolder'), () => showFile(t));
  } else if (t.state === 'downloading' && t.hls?.live) {
    btn('stop', i18n('stopRecording'), () => act('stop', [t.id]), true);
  } else if (t.state === 'downloading' || t.state === 'queued') {
    btn('pause', i18n('pause'), () => act('pause', [t.id]));
  } else if (t.state === 'paused' || t.state === 'error') {
    btn('play', i18n('resume'), () => act('resume', [t.id]), true);
  }
  btn('copy', i18n('actionCopyLink'), () => copy(t.url));
  if ((t.state === 'completed' || t.state === 'error') && t.type !== 'blob') btn('redo', i18n('redownload'), () => act('redownload', [t.id]));

  const tag = h('span', { class: `tag ${t.state === 'completed' ? 'tag-done' : t.state === 'error' ? 'tag-error' : t.state === 'downloading' ? 'tag-thread' : ''}` }, stateText(t));
  const head = h('div', { class: 'd-head' }, h('div', { class: 'd-title ellipsis', title: t.filename }, t.filename), tag, actions);
  const loom = h('canvas', { class: 'loom big' });
  const stats = h('div', { class: 'd-stats' });
  const threadsWrap = h('div', { class: 'threads-wrap hidden' }, h('div', { class: 'threads-label' }), h('canvas', { class: 'threads' }));
  const kv = h('dl', { class: 'kv' });
  const add = (k, v, cls = '') => {
    if (v == null || v === '') return;
    kv.append(h('dt', {}, k), h('dd', { class: cls }, v));
  };
  add(i18n('kvUrl'), link(t.url));
  if (t.pageUrl) add(i18n('kvSourcePage'), link(t.pageUrl, t.pageTitle || t.pageUrl));
  if (t.savedPath) add(i18n('kvSavedTo'), t.savedPath);
  if (t.type === 'http' && t.resumable != null) add(i18n('kvResumable'), i18n(t.resumable ? 'resumableYes' : 'resumableNo'));
  if (t.type === 'hls') {
    if (t.hls?.quality) add(i18n('kvQuality'), t.hls.quality);
    if (t.hls?.encrypted === 'aes-128') add(i18n('kvEncryption'), i18n('aesDecrypted'));
    add(i18n('kvOutput'), t.hls?.format === 'ts' ? 'TS' : i18n('outputMp4'));
  }
  if (t.type === 'merge') add(i18n('kvParts'), t.parts.map((p) => i18n(p.role === 'audio' ? 'partAudio' : 'partVideo', p.size ? formatBytes(p.size) : '').trim()).join(' + '));
  if (t.note) add(i18n('kvNote'), t.note);
  if (t.error) add(i18n('kvError'), t.error, 'err');
  add(i18n('kvAdded'), new Date(t.createdAt).toLocaleString(uiLocale()));
  if (t.completedAt) add(i18n('kvCompleted'), new Date(t.completedAt).toLocaleString(uiLocale()));
  box.replaceChildren(head, loom, stats, threadsWrap, kv);
  detailRefs = { loom, stats, threadsWrap };
  updateDetailLive(t);
}

function link(url, text) {
  if (!/^https?:\/\//i.test(url || '')) return text || url;
  return h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text || url);
}

function updateDetailLive(t) {
  if (!detailRefs || detailId !== t.id) return;
  drawLoom(detailRefs.loom, loomOpts(t));
  const s = detailRefs.stats;
  s.replaceChildren();
  const stat = (k, v) => s.append(h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v data' }, v)));
  const p = pctOf(t);
  stat(i18n('statDownloaded'), t.size ? `${formatBytes(t.received)} / ${formatBytes(t.size)}` : formatBytes(t.received));
  if (p != null && t.state !== 'completed') stat(i18n('colProgress'), `${p}%`);
  if (t.state === 'downloading') {
    stat(i18n('colSpeed'), formatSpeed(t.speed));
    if (!t.hls?.live) stat(i18n('colEta'), formatEta(t.eta));
  }
  if (t.conns?.length && t.state === 'downloading') stat(i18n('statConnections'), String(t.conns.length));
  if (t.hls?.total) stat(i18n(t.hls.live ? 'statRecorded' : 'statSegments'), t.hls.live ? formatDuration(t.hls.doneDuration) : `${t.hls.done} / ${t.hls.total}`);
  const tw = detailRefs.threadsWrap;
  const show = t.state === 'downloading' && t.conns?.length && t.size;
  tw.classList.toggle('hidden', !show);
  if (show) {
    tw.querySelector('.threads-label').textContent = tp('threadsLabel', t.conns.length);
    drawThreads(tw.querySelector('canvas'), t.conns, t.size);
  }
}

// ---------- Dialogs ----------

function openNewDialog(prefill = '') {
  const d = $('dlgNew');
  $('newUrls').value = prefill;
  $('newName').value = '';
  $('newDir').value = '';
  $('newReferer').value = '';
  $('newThreads').value = '';
  d.showModal();
  $('newUrls').focus();
}

$('newUrls').addEventListener('input', () => {
  const n = $('newUrls').value.split(/\s+/).filter((s) => /^https?:\/\//i.test(s)).length;
  $('newName').disabled = n > 1;
  if (n > 1) $('newName').value = '';
});

$('dlgNew').addEventListener('close', async () => {
  if ($('dlgNew').returnValue !== 'ok') return;
  const urls = [...new Set($('newUrls').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))];
  if (!urls.length) return toast(i18n('noHttpLinks'), 'error');
  const common = {
    dir: $('newDir').value.trim(),
    referer: $('newReferer').value.trim(),
    threads: Number($('newThreads').value) || null,
    source: 'manual',
  };
  const name = urls.length === 1 ? $('newName').value.trim() : '';
  try {
    const r = await bg('addDownloads', { tasks: urls.map((url) => ({ url, filename: name, ...common })) });
    if (r.ids?.length) toast(tp('addedTasks', r.ids.length));
    if (r.duplicates?.length) toast(tp('duplicatesN', r.duplicates.length));
  } catch (e) {
    toast(e.message, 'error');
  }
});

let deleteIds = [];
function openDeleteDialog(ids) {
  if (!ids.length) return;
  deleteIds = ids;
  const list = ids.map((id) => tasks.get(id)).filter(Boolean);
  $('delTitle').textContent = list.length > 1 ? tp('deleteNTitle', list.length) : i18n('deleteOneTitle');
  const unfinished = list.filter((t) => t.state !== 'completed').length;
  $('delText').textContent = list.length === 1
    ? [i18n('deleteOneText', list[0].filename), unfinished ? i18n('deleteTempToo') : ''].filter(Boolean).join(' ')
    : [i18n('deleteManyText'), unfinished ? tp('deleteManyTemp', unfinished) : ''].filter(Boolean).join(' ');
  const anyFile = list.some((t) => t.state === 'completed' && t.downloadId != null);
  $('delFileRow').classList.toggle('hidden', !anyFile);
  $('delFile').checked = false;
  $('dlgDelete').showModal();
}

$('dlgDelete').addEventListener('close', () => {
  if ($('dlgDelete').returnValue !== 'ok') return;
  act('remove', deleteIds, { deleteFile: $('delFile').checked });
  selected = new Set();
});

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Escape') { hideContext(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selected = new Set(visible);
    for (const [rid, r] of rows) r.tr.classList.toggle('sel', selected.has(rid));
    updateToolbar();
    renderDetail();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openNewDialog();
    return;
  }
  if (!selected.size) return;
  const sel = [...selected].map((id) => tasks.get(id)).filter(Boolean);
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    openDeleteDialog(sel.map((t) => t.id));
  } else if (e.key === ' ') {
    e.preventDefault();
    if (sel.some((t) => t.state === 'downloading' || t.state === 'queued')) act('pause', sel.map((t) => t.id));
    else act('resume', sel.map((t) => t.id));
  } else if (e.key === 'Enter' && sel.length === 1 && sel[0].state === 'completed') {
    openFile(sel[0]);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const cur = visible.indexOf(anchor);
    const next = visible[Math.max(0, Math.min(visible.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selected = new Set([next]);
      anchor = next;
      for (const [rid, r] of rows) r.tr.classList.toggle('sel', selected.has(rid));
      rows.get(next)?.tr.scrollIntoView({ block: 'nearest' });
      updateToolbar();
      renderDetail();
    }
  }
});

// ---------- Live updates ----------

function onEngine(msg) {
  if (msg.type === 'task') {
    const old = tasks.get(msg.task.id);
    const t = { ...(old || {}), ...msg.task };
    if (t.state !== 'downloading') { t.map = null; t.conns = null; }
    tasks.set(t.id, t);
    const structural = !old || old.state !== t.state || old.filename !== t.filename;
    if (structural) {
      renderNav();
      renderList();
    } else {
      const r = rows.get(t.id);
      if (r) updateRow(r, t);
      if (detailId === t.id) renderDetail();
    }
  } else if (msg.type === 'removed') {
    tasks.delete(msg.id);
    selected.delete(msg.id);
    renderNav();
    renderList();
  } else if (msg.type === 'progress') {
    let structural = false;
    for (const p of msg.items) {
      const t = tasks.get(p.id);
      if (!t) continue;
      const stateChanged = t.state !== p.state;
      const hls = t.hls && p.hls ? { ...t.hls, ...p.hls } : p.hls || t.hls;
      Object.assign(t, p);
      t.hls = hls;
      if (stateChanged) {
        structural = true;
        continue;
      }
      const r = rows.get(t.id);
      if (r) updateRow(r, t);
      if (detailId === t.id) updateDetailLive(t);
    }
    if (structural) {
      renderNav();
      renderList();
    }
    updateStatus();
  }
}

async function updateStatus() {
  const active = [...tasks.values()].filter((t) => t.state === 'downloading');
  const speed = active.reduce((a, t) => a + (t.speed || 0), 0);
  $('stSpeed').textContent = active.length ? tp('statusActive', active.length, formatSpeed(speed)) : i18n('statusIdle');
}

let lastUsage = '';
async function updateUsage() {
  const right = $('stRight');
  right.replaceChildren();
  try {
    const est = await navigator.storage.estimate();
    lastUsage = formatBytes(est.usage || 0);
  } catch { /* ignore */ }
  if (settings?.speedLimitKB) right.append(h('span', {}, i18n('statusLimit', formatSpeed(settings.speedLimitKB * 1024))));
  right.append(h('span', {}, i18n(settings?.takeover ? 'statusTakeoverOn' : 'statusTakeoverOff')));
  if (lastUsage) right.append(h('span', { class: 'data', title: i18n('tempDataTitle') }, i18n('tempData', lastUsage)));
}

function welcome() {
  const q = new URLSearchParams(location.search);
  if (!q.has('welcome') && load('welcomed', false)) return;
  if (!q.has('welcome') && tasks.size) return;
  const box = $('welcome');
  const ok = h('button', { class: 'btn btn-primary' }, i18n('gotIt'));
  const set = h('button', { class: 'btn' }, i18n('openSettings'));
  ok.onclick = () => { box.classList.add('hidden'); save('welcomed', true); };
  set.onclick = () => chrome.runtime.openOptionsPage();
  box.replaceChildren(
    h('div', { class: 'w-body' },
      h('strong', {}, i18n('welcomeTitle')),
      h('ul', {},
        h('li', {}, i18n('welcome1')),
        h('li', {}, i18n('welcome2')),
        h('li', {}, i18n('welcome3')),
      ),
    ),
    h('div', { class: 'w-actions' }, set, ok),
  );
  box.classList.remove('hidden');
}

async function main() {
  setupChrome();
  subscribe(onEngine);
  settings = await getSettings();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) {
      settings = { ...settings, ...ch.settings.newValue };
      updateUsage();
    }
  });
  try {
    const { tasks: list } = await bg('listTasks');
    for (const t of list) tasks.set(t.id, t);
  } catch (e) {
    toast(i18n('engineUnavailable', e.message), 'error');
  }
  renderNav();
  const q = new URLSearchParams(location.search);
  const focus = q.get('task');
  if (focus && tasks.has(focus)) {
    if (!matches(tasks.get(focus))) setFilter({ kind: 'state', value: 'all' });
    selected = new Set([focus]);
    anchor = focus;
  }
  renderList();
  if (focus) rows.get(focus)?.tr.scrollIntoView({ block: 'center' });
  if (q.has('new')) openNewDialog(q.get('url') || '');
  welcome();
  updateStatus();
  updateUsage();
  setInterval(updateUsage, 10000);
  new ResizeObserver(() => {
    redrawLooms();
    const t = detailId && tasks.get(detailId);
    if (t) updateDetailLive(t);
  }).observe($('tableWrap'));
}

main();
