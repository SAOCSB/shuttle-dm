// Shared helpers for driving the extension inside Chromium.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// Note: branded Google Chrome 137+ ignores --load-extension; use Chrome for Testing (bundled with puppeteer) or Chromium
export const CHROME = process.env.CHROME_PATH || puppeteer.executablePath();
export const EXT = process.env.EXT_DIR || path.resolve(HERE, '../extension');
export const WORK = path.join(HERE, '.work');
export const DL = path.join(WORK, 'downloads');
export const SERVER = 'http://127.0.0.1:8080';
// Browser UI language, which decides the extension's language (en, zh-CN, fr, ja, ko)
export const UI_LANG = process.env.UI_LANG || 'en-US';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(profile, { fresh = true, args = [] } = {}) {
  if (fresh) fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile + '/Default', { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  const prefsPath = profile + '/Default/Preferences';
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(prefsPath, JSON.stringify({
      download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: DL },
    }));
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    // In headless mode the browser names downloads with random GUIDs, so run headed by default (use xvfb-run on Linux without a desktop)
    headless: process.env.HEADLESS ? true : false,
    userDataDir: profile,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu', `--lang=${UI_LANG}`, ...args],
    defaultViewport: { width: 1280, height: 820 },
    protocolTimeout: 180000,
    // With the C locale on Linux, the browser rejects non-ASCII file names
    env: process.platform === 'linux' ? { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LANGUAGE: UI_LANG.replace('-', '_') } : process.env,
  });
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('/background/sw.js'), { timeout: 20000 });
  const extId = new URL(swT.url()).host;
  const ext = await browser.newPage();
  ext.on('console', (m) => { if (process.env.VERBOSE) console.log('[ext page]', m.text()); });
  await ext.goto(`chrome-extension://${extId}/ui/options.html`);
  const send = async (cmd, data = {}) => ext.evaluate((cmd, data) => chrome.runtime.sendMessage({ to: 'bg', cmd, ...data }), cmd, data);
  return { browser, extId, swT, ext, send };
}

export async function attachEngineConsole(browser, extId) {
  // Offscreen document shows up as a 'other'/'page' target; capture its console for debugging
  const t = await browser.waitForTarget((t) => t.url().includes(`${extId}/engine/offscreen.html`), { timeout: 15000 }).catch(() => null);
  if (!t) return null;
  const page = await t.asPage().catch(() => null);
  if (page) page.on('console', (m) => console.log('[engine]', m.type(), m.text()));
  return page;
}

export async function waitTask(send, id, pred = (t) => ['completed', 'error'].includes(t.state), timeout = 120000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    const r = await send('listTasks');
    last = (r.tasks || []).find((t) => t.id === id);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting task ${id}: ${JSON.stringify(last && { state: last.state, received: last.received, size: last.size, error: last.error })}`);
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames:format=duration,format_name', '-of', 'json', file]).toString());
  return { format: j.format.format_name, duration: Number(j.format.duration), streams: j.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ' ' + s.width + 'x' + s.height : ''} frames=${s.nb_frames}`) };
}

export function decodeOk(file) {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    return out === '' ? true : out;
  } catch (e) {
    return String(e.stderr || e.message).slice(0, 300);
  }
}

export async function serverLog(reset = false) {
  const r = await fetch(`${SERVER}/__log`);
  const j = await r.json();
  if (reset) await fetch(`${SERVER}/__reset`);
  return j;
}
