import { LOGO } from './common.js';
import { DEFAULT_SETTINGS, DEFAULT_TAKEOVER_EXTS, getSettings, clampSettings } from '../common/settings.js';
import { formatBytes } from '../common/util.js';
import { i18n, localizePage } from '../common/i18n.js';

const $ = (id) => document.getElementById(id);
const NUMBERS = ['threads', 'maxConcurrent', 'speedLimitKB', 'retries', 'sniffMinKB', 'takeoverMinKB', 'hlsConcurrency'];
const SWITCHES = ['categorize', 'notify', 'showOverlay', 'takeover'];
const TEXTS = ['subfolder', 'takeoverExts', 'takeoverExclude'];
let current = null;
let savedTimer = 0;

function fill(s) {
  for (const k of NUMBERS) $(k).value = s[k];
  for (const k of SWITCHES) $(k).checked = !!s[k];
  for (const k of TEXTS) $(k).value = s[k] || '';
  for (const r of document.querySelectorAll('input[name="hlsFormat"]')) r.checked = r.value === s.hlsFormat;
}

function read() {
  const s = { ...current };
  for (const k of NUMBERS) s[k] = Number($(k).value);
  for (const k of SWITCHES) s[k] = $(k).checked;
  for (const k of TEXTS) s[k] = $(k).value.trim();
  s.takeoverExts = s.takeoverExts.toLowerCase().replace(/[.,;，、]+/g, ' ').replace(/\s+/g, ' ').trim();
  s.hlsFormat = document.querySelector('input[name="hlsFormat"]:checked')?.value || 'mp4';
  return clampSettings(s);
}

async function persist() {
  const next = read();
  current = next;
  await chrome.storage.local.set({ settings: next });
  const el = $('saved');
  el.textContent = i18n('saved');
  el.classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('on'), 1600);
}

function bind() {
  for (const k of [...NUMBERS, ...TEXTS]) {
    $(k).addEventListener('change', async () => {
      await persist();
      fill(current); // show the normalized value
    });
  }
  for (const k of SWITCHES) $(k).addEventListener('change', persist);
  for (const r of document.querySelectorAll('input[name="hlsFormat"]')) r.addEventListener('change', persist);
  $('resetExts').onclick = async () => {
    $('takeoverExts').value = DEFAULT_TAKEOVER_EXTS;
    await persist();
  };
  $('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

async function usage() {
  try {
    const est = await navigator.storage.estimate();
    $('usage').textContent = formatBytes(est.usage || 0);
  } catch {
    $('usage').textContent = '—';
  }
}

async function main() {
  localizePage();
  $('brand').insertAdjacentHTML('afterbegin', LOGO);
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = i18n('aboutVersion', manifest.version);
  if (manifest.homepage_url) {
    $('homepage').href = manifest.homepage_url;
    $('homepage').textContent = i18n('aboutSource', manifest.homepage_url.replace(/^https:\/\//, ''));
  }
  current = clampSettings({ ...DEFAULT_SETTINGS, ...(await getSettings()) });
  fill(current);
  bind();
  usage();
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === 'open-manager');
    $('shortcutText').textContent = c?.shortcut ? i18n('shortcutIs', c.shortcut) : i18n('shortcutNone');
  } catch { /* ignore */ }
}

main();
