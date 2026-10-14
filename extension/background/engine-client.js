// Manages the offscreen document that runs the download engine, and talks to it.

import { i18n } from '../common/i18n.js';

const OFFSCREEN_URL = chrome.runtime.getURL('engine/offscreen.html');
let creating = null;

export async function hasEngine() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  return ctx.length > 0;
}

export async function ensureEngine() {
  if (await hasEngine()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Runs the multi-connection download engine and hands finished files to the browser for saving',
      })
      .catch((e) => {
        if (!/single offscreen|already/i.test(String(e?.message))) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function engine(cmd, data = {}) {
  await ensureEngine();
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ to: 'engine', cmd, ...data });
      if (r === undefined) throw Object.assign(new Error(i18n('errEngineNoResponse')), { code: 'ENGINE_NO_RESPONSE' });
      if (r && r.error) {
        const err = new Error(r.error);
        err.remote = true;
        throw err;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (e.remote || (e.code !== 'ENGINE_NO_RESPONSE' && !/Receiving end does not exist|Could not establish/i.test(e.message))) throw e;
      await new Promise((res) => setTimeout(res, 150 * (i + 1)));
      await ensureEngine();
    }
  }
  throw lastErr;
}

export async function engineIfRunning(cmd, data = {}) {
  if (!(await hasEngine())) return null;
  return engine(cmd, data);
}
