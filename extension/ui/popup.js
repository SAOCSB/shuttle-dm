import { bg, subscribe, icon, LOGO, h, toast, drawLoom, activeTab, STATE_LABEL } from './common.js';
import { formatBytes, formatSpeed, formatEta } from '../common/util.js';
import { getSettings, saveSettings } from '../common/settings.js';
import { isVideoBlockedUrl, blockedSiteMessage } from '../common/sites.js';
import { i18n, tp, localizePage } from '../common/i18n.js';

const $ = (id) => document.getElementById(id);
let tab = null;
const active = new Map();
const ACTIVE_STATES = new Set(['queued', 'downloading', 'merging', 'saving', 'paused']);

function withIcon(el, ico, key) {
  el.innerHTML = icon(ico);
  el.append(h('span', {}, i18n(key)));
}

function setupChrome() {
  localizePage();
  $('brand').insertAdjacentHTML('afterbegin', LOGO);
  withIcon($('openManager'), 'manager', 'managerShort');
  $('openOptions').innerHTML = icon('sliders');
  withIcon($('saveMhtml'), 'page', 'toolSavePage');
  withIcon($('saveHtml'), 'html', 'toolSaveHtml');
  withIcon($('grabAll'), 'grab', 'toolGrab');
  withIcon($('newTask'), 'plus', 'toolNewTask');
  $('newSubmit').innerHTML = icon('download');
  $('newSubmit').append(i18n('startDownload'));
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  $('openManager').onclick = () => { bg('openManager'); window.close(); };
  $('viewAll').onclick = () => { bg('openManager'); window.close(); };
  $('openOptions').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
  $('clearMedia').onclick = async () => {
    await bg('clearTabMedia', { tabId: tab.id });
    renderMedia([]);
  };
  $('saveMhtml').onclick = () => pageAction('mhtml');
  $('saveHtml').onclick = () => pageAction('html');
  $('grabAll').onclick = async () => {
    try {
      await bg('grabLinks', { tabId: tab.id });
      window.close();
    } catch (e) {
      toast(friendly(e), 'error');
    }
  };
  $('newTask').onclick = () => {
    $('newForm').classList.toggle('hidden');
    if (!$('newForm').classList.contains('hidden')) $('newUrls').focus();
  };
  $('newCancel').onclick = () => $('newForm').classList.add('hidden');
  $('newForm').onsubmit = async (e) => {
    e.preventDefault();
    const urls = $('newUrls').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    if (!urls.length) return toast(i18n('enterHttpLinks'), 'error');
    try {
      const r = await bg('addDownloads', { tasks: urls.map((url) => ({ url, source: 'manual' })) });
      toast(r.ids?.length ? tp('addedTasks', r.ids.length) : i18n('linksAlreadyListed'));
      $('newUrls').value = '';
      $('newForm').classList.add('hidden');
      refreshActive();
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
}

function friendly(e) {
  const m = String(e?.message || e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery/i.test(m)) return i18n('pageNotAllowed');
  return m;
}

async function pageAction(format) {
  const btn = format === 'mhtml' ? $('saveMhtml') : $('saveHtml');
  btn.disabled = true;
  try {
    await bg('savePage', { tabId: tab.id, format });
    toast(i18n(format === 'mhtml' ? 'pageSavedMhtml' : 'pageSavedHtml'));
  } catch (e) {
    toast(friendly(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Media on this page ----------

function renderMedia(entries, loading = false, blocked = false) {
  const list = $('mediaList');
  list.replaceChildren();
  $('mediaCount').textContent = entries.length ? String(entries.length) : '';
  $('clearMedia').classList.toggle('hidden', !entries.length);
  if (blocked) {
    list.append(h('div', { class: 'empty' }, h('strong', {}, i18n('siteNotSupported')), `${blockedSiteMessage()} ${i18n('otherFeaturesStillWork')}`));
    return;
  }
  if (loading) {
    list.append(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), i18n('mediaLoading')));
    return;
  }
  if (!entries.length) {
    list.append(
      h('div', { class: 'empty' },
        h('strong', {}, i18n('mediaEmptyTitle')),
        i18n('mediaEmptyBody')),
    );
    return;
  }
  for (const e of entries) list.append(renderEntry(e));
}

function renderEntry(e) {
  const kindIcon = { hls: 'stream', merge: 'merge', audio: 'audio', dash: 'stream', track: 'stream' }[e.kind] || 'video';
  const meta = h('div', { class: 'item-meta' });
  (e.meta || []).forEach((m, i) => meta.append(i === 0 ? h('span', { class: 'tag' }, m) : h('span', { class: 'data' }, m)));

  let select = null;
  if (e.choices?.length) {
    select = h('select', { class: 'select', 'aria-label': i18n('chooseQuality') });
    e.choices.forEach((c, i) => select.append(h('option', { value: i }, c.label)));
  }
  const actionLabel = i18n(e.action === 'record' ? 'actionRecord' : e.action === 'copy' ? 'actionCopyLink' : 'actionDownload');
  const actionIcon = e.action === 'record' ? 'record' : e.action === 'copy' ? 'copy' : 'download';
  const btn = h('button', { class: `btn ${e.action === 'copy' ? '' : 'btn-primary'}`, disabled: !!e.disabled, html: icon(actionIcon) }, actionLabel);
  btn.onclick = async () => {
    if (e.action === 'copy') {
      await navigator.clipboard.writeText(e.url);
      return toast(i18n('linkCopied'));
    }
    const params = select ? e.choices[Number(select.value)].params : e.params;
    btn.disabled = true;
    try {
      const r = await bg('addDownload', { task: params });
      if (r.ids?.length) toast(i18n(e.action === 'record' ? 'recordStarted' : 'downloadStarted'));
      else toast(i18n('alreadyInList'));
      refreshActive();
    } catch (err) {
      toast(friendly(err), 'error');
    } finally {
      btn.disabled = !!e.disabled;
    }
  };
  const copyBtn = e.action !== 'copy'
    ? h('button', { class: 'btn btn-quiet btn-icon', title: i18n('actionCopyLink'), 'aria-label': i18n('actionCopyLink'), html: icon('copy') })
    : null;
  if (copyBtn) copyBtn.onclick = async () => { await navigator.clipboard.writeText(e.url); toast(i18n('linkCopied')); };

  const body = h('div', { class: 'item-body' }, h('div', { class: 'item-title ellipsis', title: e.title }, e.title));
  if (select) {
    body.append(meta);
    body.append(h('div', { class: 'item-line' }, select, copyBtn, btn));
  } else {
    body.append(h('div', { class: 'item-line' }, meta, copyBtn, btn));
  }
  if (e.note) body.append(h('div', { class: `item-note ${e.warn ? 'warn' : ''}` }, e.note));
  return h('div', { class: `item ${e.disabled ? 'disabled' : ''}`, dataset: { kind: e.kind } }, h('div', { class: 'item-ico', html: icon(kindIcon) }), body);
}

async function loadMedia() {
  if (!tab?.id || !/^https?:|^file:/i.test(tab.url || 'https:')) {
    renderMedia([]);
    return;
  }
  if (isVideoBlockedUrl(tab.url)) {
    renderMedia([], false, true);
    return;
  }
  renderMedia([], true);
  try {
    const view = await bg('getTabMedia', { tabId: tab.id });
    renderMedia(view.entries || []);
  } catch (e) {
    renderMedia([]);
    toast(friendly(e), 'error');
  }
}

// ---------- Downloads in progress ----------

function renderActive() {
  const list = [...active.values()].sort((a, b) => a.createdAt - b.createdAt);
  $('activeSec').classList.toggle('hidden', !list.length);
  $('activeCount').textContent = String(list.length);
  const host = $('activeList');
  host.replaceChildren();
  for (const task of list.slice(0, 5)) {
    const row = h('div', { class: 'act', dataset: { id: task.id, state: task.state }, title: task.filename });
    row.append(
      h('div', { class: 'act-top' }, h('span', { class: 'act-name ellipsis data' }, task.filename), h('span', { class: 'act-pct data' }, pctText(task))),
      h('canvas', { class: 'loom' }),
      h('div', { class: 'act-bottom' }, h('span', { class: 'data' }, speedText(task)), h('span', { class: 'data' }, sizeText(task))),
    );
    row.onclick = () => { bg('openManager', { query: `?task=${task.id}` }); window.close(); };
    host.append(row);
    drawLoom(row.querySelector('canvas'), loomOpts(task));
  }
}

function pctText(task) {
  if (task.state !== 'downloading') return STATE_LABEL[task.state] || '';
  if (task.hls?.live) return i18n('stateRecording');
  return task.size ? `${Math.floor((task.received / task.size) * 100)}%` : formatBytes(task.received);
}

function speedText(task) {
  if (task.state !== 'downloading') return STATE_LABEL[task.state] || '';
  return task.eta != null ? i18n('speedWithEta', formatSpeed(task.speed), formatEta(task.eta)) : formatSpeed(task.speed);
}

function sizeText(task) {
  return task.size ? `${formatBytes(task.received)} / ${formatBytes(task.size)}` : formatBytes(task.received);
}

function loomOpts(task) {
  return { map: task.map, conns: task.conns, size: task.size, state: task.state, ratio: task.size ? task.received / task.size : null };
}

async function refreshActive() {
  try {
    const { tasks } = await bg('listTasks');
    active.clear();
    for (const task of tasks) if (ACTIVE_STATES.has(task.state) && task.state !== 'paused') active.set(task.id, task);
    renderActive();
  } catch { /* the engine isn't running */ }
}

function onEngine(msg) {
  if (msg.type === 'task') {
    const task = msg.task;
    if (ACTIVE_STATES.has(task.state) && task.state !== 'paused') active.set(task.id, { ...(active.get(task.id) || {}), ...task });
    else active.delete(task.id);
    renderActive();
  } else if (msg.type === 'removed') {
    active.delete(msg.id);
    renderActive();
  } else if (msg.type === 'progress') {
    let changed = false;
    for (const p of msg.items) {
      const task = active.get(p.id);
      if (!task) continue;
      Object.assign(task, p);
      changed = true;
      const row = document.querySelector(`.act[data-id="${CSS.escape(p.id)}"]`);
      if (!row) continue;
      row.dataset.state = task.state;
      row.querySelector('.act-pct').textContent = pctText(task);
      const [sp, sz] = row.querySelectorAll('.act-bottom .data');
      sp.textContent = speedText(task);
      sz.textContent = sizeText(task);
      drawLoom(row.querySelector('canvas'), loomOpts(task));
    }
    void changed;
  }
}

async function main() {
  setupChrome();
  tab = await activeTab();
  const s = await getSettings();
  $('takeover').checked = !!s.takeover;
  $('takeover').onchange = async () => {
    await saveSettings({ takeover: $('takeover').checked });
    toast(i18n($('takeover').checked ? 'takeoverOn' : 'takeoverOff'));
  };
  if (!/^https?:/i.test(tab?.url || 'https:')) {
    for (const id of ['saveMhtml', 'saveHtml', 'grabAll']) $(id).disabled = true;
  }
  subscribe(onEngine);
  loadMedia();
  refreshActive();
}

main();
