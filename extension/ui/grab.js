import { bg, icon, LOGO, h, toast, categoryIcon } from './common.js';
import { CATEGORY_LIST, extOf, filenameFromUrl, sanitizeFilename, categoryOf, hostOf } from '../common/util.js';
import { i18n, tp, pluralKey, tNodes, formatNumber, localizePage } from '../common/i18n.js';

const $ = (id) => document.getElementById(id);
const FILE_CATS = new Set(['video', 'audio', 'document', 'archive', 'program']);
let data = null;
let items = [];
let tab = 'all';
let query = '';
const checked = new Set();
let shown = [];
let lastClicked = -1;

function classify(it) {
  const name = filenameFromUrl(it.url);
  const ext = extOf(name);
  let cat = ext ? categoryOf(name, '') : 'page';
  if (it.tag === 'img') cat = 'image';
  else if (it.tag === 'video') cat = 'video';
  else if (it.tag === 'audio') cat = 'audio';
  else if (!ext && it.tag === 'a') cat = 'page';
  if (cat === 'other' && !ext) cat = 'page';
  return { ...it, name: name || hostOf(it.url), ext, cat };
}

function toRegex(q) {
  if (!q.includes('*')) return null;
  const esc = q.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(esc, 'i'); } catch { return null; }
}

function visibleItems() {
  const re = toRegex(query);
  return items.filter((it) => {
    if (tab !== 'all' && it.cat !== tab) return false;
    if (!query) return true;
    const hay = `${it.url} ${it.text} ${it.name}`;
    return re ? re.test(hay) : hay.toLowerCase().includes(query.toLowerCase());
  });
}

function renderTabs() {
  const counts = {};
  for (const it of items) counts[it.cat] = (counts[it.cat] || 0) + 1;
  const list = [{ id: 'all', name: i18n('tabAll') }, ...CATEGORY_LIST.filter((c) => counts[c.id])];
  $('tabs').replaceChildren(
    ...list.map((c) => {
      const n = c.id === 'all' ? items.length : counts[c.id];
      const b = h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === c.id) }, c.name, h('span', { class: 'n' }, String(n)));
      b.onclick = () => {
        tab = c.id;
        renderTabs();
        renderRows();
      };
      return b;
    }),
  );
}

function renderRows() {
  shown = visibleItems();
  const tbody = $('rows');
  tbody.replaceChildren();
  const frag = document.createDocumentFragment();
  shown.forEach((it, idx) => {
    const cb = h('input', { type: 'checkbox', 'aria-label': i18n('selectItem', it.name) });
    cb.checked = checked.has(it.url);
    const tr = h('tr', { class: cb.checked ? 'on' : '' },
      h('td', {}, cb),
      h('td', {}, h('div', { class: 'name', html: icon(categoryIcon(it.cat)) }, h('span', { class: 'cell', title: it.name }, it.name))),
      h('td', {}, h('div', { class: 'cell', title: it.text }, it.text || '')),
      h('td', {}, h('div', { class: 'cell url data', title: it.url }, it.url.replace(/^https?:\/\//, ''))),
    );
    const toggle = (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
      if (e.shiftKey && lastClicked >= 0) {
        const [lo, hi] = lastClicked < idx ? [lastClicked, idx] : [idx, lastClicked];
        for (let i = lo; i <= hi; i++) {
          if (cb.checked) checked.add(shown[i].url);
          else checked.delete(shown[i].url);
        }
        lastClicked = idx;
        renderRows();
        return;
      }
      if (cb.checked) checked.add(it.url);
      else checked.delete(it.url);
      tr.classList.toggle('on', cb.checked);
      lastClicked = idx;
      updateCount();
    };
    tr.addEventListener('click', toggle);
    frag.append(tr);
  });
  tbody.append(frag);
  $('empty').classList.toggle('hidden', shown.length > 0);
  $('empty').textContent = i18n(items.length ? 'grabNoMatch' : 'grabNoLinks');
  updateCount();
}

function updateCount() {
  const n = checked.size;
  $('count').replaceChildren(...tNodes(pluralKey('selectedCount', n), h('b', {}, formatNumber(n))));
  $('go').disabled = n === 0;
  $('go').innerHTML = icon('download');
  $('go').append(i18n('downloadSelected'));
  const vis = shown.filter((it) => checked.has(it.url)).length;
  $('checkAll').checked = shown.length > 0 && vis === shown.length;
  $('checkAll').indeterminate = vis > 0 && vis < shown.length;
}

async function go() {
  const list = items.filter((it) => checked.has(it.url));
  if (!list.length) return;
  const dir = $('folder').value.trim();
  $('go').disabled = true;
  try {
    if ($('mode').value === 'browser') {
      const r = await bg('browserDownload', { items: list.map((it) => ({ url: it.url, filename: it.ext ? it.name : '' })), dir });
      toast(tp('sentToBrowser', r.count));
    } else {
      const r = await bg('addDownloads', {
        tasks: list.map((it) => ({ url: it.url, referer: data.pageUrl, pageUrl: data.pageUrl, pageTitle: data.title, dir, source: 'grab' })),
      });
      toast(tp('addedTasks', r.ids?.length || 0));
      if (r.duplicates?.length) toast(tp('duplicatesN', r.duplicates.length));
      setTimeout(() => bg('openManager'), 900);
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    $('go').disabled = false;
  }
}

async function main() {
  localizePage();
  $('brand').insertAdjacentHTML('afterbegin', LOGO);
  $('searchIcon').outerHTML = icon('search');
  const key = new URLSearchParams(location.search).get('key');
  const stored = key ? (await chrome.storage.session.get(key))[key] : null;
  if (!stored) {
    $('empty').classList.remove('hidden');
    $('empty').textContent = i18n('grabExpired');
    $('go').disabled = true;
    return;
  }
  data = stored;
  document.title = i18n('grabPageTitleWith', data.title || hostOf(data.pageUrl));
  $('source').textContent = [data.selection ? i18n('grabSelection') : '', data.title || '', data.pageUrl].filter(Boolean).join(' · ');
  items = data.items.map(classify);
  for (const it of items) if (FILE_CATS.has(it.cat)) checked.add(it.url);
  $('folder').value = sanitizeFilename(data.title || '', '').slice(0, 60);
  $('search').oninput = (e) => {
    query = e.target.value.trim();
    renderRows();
  };
  $('checkAll').onchange = () => {
    for (const it of shown) {
      if ($('checkAll').checked) checked.add(it.url);
      else checked.delete(it.url);
    }
    renderRows();
  };
  $('go').onclick = go;
  renderTabs();
  renderRows();
}

main();
