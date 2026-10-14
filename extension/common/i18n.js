// Translation helpers shared by every part of the extension.
//
// Messages live in _locales/<locale>/messages.json. Extension pages, the service worker and
// content scripts read them through chrome.i18n. The offscreen document that runs the download
// engine cannot use chrome.i18n, so it loads the same files with initI18n() before it starts.

export const LOCALES = ['en', 'zh_CN', 'fr', 'ja', 'ko'];
export const DEFAULT_LOCALE = 'en';

let catalog = null; // { key: message } when chrome.i18n is unavailable
let catalogLocale = DEFAULT_LOCALE;

function chromeI18n() {
  try {
    return typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function' ? chrome.i18n : null;
  } catch {
    return null;
  }
}

/** Fill $1…$9 the same way chrome.i18n.getMessage does ($$ is a literal dollar sign). */
function substitute(message, subs) {
  return message.replace(/\$(\$|[1-9])/g, (_, d) => (d === '$' ? '$' : subs[Number(d) - 1] ?? ''));
}

/** Translate a message key. Substitutions may be numbers or strings. */
export function i18n(key, ...subs) {
  const args = subs.flat().map((s) => String(s ?? ''));
  const api = chromeI18n();
  if (api && !catalog) {
    const m = api.getMessage(key, args);
    if (m) return m;
  }
  if (catalog && Object.prototype.hasOwnProperty.call(catalog, key)) return substitute(catalog[key], args);
  return key;
}

/** `${key}_one` or `${key}_other`, following the plural rules of the UI language. */
export function pluralKey(key, n) {
  let form = 'other';
  try {
    form = new Intl.PluralRules(uiLocale()).select(Number(n)) === 'one' ? 'one' : 'other';
  } catch { /* keep "other" */ }
  return `${key}_${form}`;
}

/** Plural-aware translation; the count is passed as $1 and further substitutions follow. */
export function tp(key, n, ...subs) {
  return i18n(pluralKey(key, n), formatNumber(n), ...subs);
}

/** BCP 47 tag of the language the messages are shown in (not just the browser language). */
export function uiLocale() {
  const tag = i18n('localeTag');
  return tag && tag !== 'localeTag' ? tag : 'en';
}

export function formatNumber(n, digits = null) {
  const opts = digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  try {
    return Number(n).toLocaleString(uiLocale(), opts);
  } catch {
    return digits == null ? String(n) : Number(n).toFixed(digits);
  }
}

/** Map a browser language such as "zh-CN" or "fr-CA" to one of our _locales folders, the way Chrome does. */
export function resolveLocale(lang) {
  const tag = String(lang || '').replace(/-/g, '_');
  const [base, region] = tag.split('_');
  const candidates = [region ? `${base.toLowerCase()}_${region.toUpperCase()}` : '', base ? base.toLowerCase() : ''];
  return candidates.find((c) => LOCALES.includes(c)) || DEFAULT_LOCALE;
}

async function fetchMessages(locale) {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL(`_locales/${locale}/messages.json`)
    : `../_locales/${locale}/messages.json`;
  const resp = await fetch(url);
  return resp.json();
}

/**
 * Load translations without chrome.i18n (offscreen document, unit tests).
 * `load(locale)` returns the parsed messages.json for that locale.
 */
export async function initI18n(lang, load = fetchMessages) {
  const locale = resolveLocale(lang);
  const flat = (json) => Object.fromEntries(Object.entries(json || {}).map(([k, v]) => [k, v.message]));
  const base = flat(await load(DEFAULT_LOCALE));
  const own = locale === DEFAULT_LOCALE ? {} : flat(await Promise.resolve().then(() => load(locale)).catch(() => ({})));
  catalog = { ...base, ...own };
  catalogLocale = locale;
  return catalogLocale;
}

/** Apply translations to static markup: data-i18n (text) and data-i18n-<attribute>. */
export function localizePage(root = document) {
  if (root === document) {
    document.documentElement.lang = uiLocale();
  }
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = i18n(el.dataset.i18n);
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, i18n(el.getAttribute(`data-i18n-${attr}`)));
  }
}

/**
 * Translate a message and return text pieces with $1… replaced by DOM nodes, so a number can be
 * styled without building HTML strings: tNodes('selectedCount_other', boldEl).
 */
export function tNodes(key, ...nodes) {
  const marks = nodes.map((_, i) => `\u0001${i}\u0001`);
  const text = i18n(key, ...marks);
  const out = [];
  for (const part of text.split(/(\u0001\d+\u0001)/)) {
    const m = /^\u0001(\d+)\u0001$/.exec(part);
    if (m) out.push(nodes[Number(m[1])]);
    else if (part) out.push(part);
  }
  return out;
}
