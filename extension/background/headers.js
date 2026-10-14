// Sets Referer / Origin on the extension's own requests with declarativeNetRequest session rules,
// so sites that check where media requests come from still serve them. The rules only match
// requests made by this extension, so normal browsing is not affected.

const FIRST_ID = 1000;
const MAX_RULES = 150; // the session rule limit is 5000; keep only the most recently used hosts
let statePromise = null;

function load() {
  if (!statePromise) {
    statePromise = chrome.storage.session.get('dnrState').then(({ dnrState }) => dnrState || { byHost: {}, nextId: FIRST_ID });
  }
  return statePromise;
}

let chain = Promise.resolve();

export function ensureHeaderRule(url, referer) {
  if (!referer || !/^https?:/i.test(referer)) return Promise.resolve();
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return Promise.resolve();
  }
  // Serialize updates so concurrent calls never reuse a rule ID
  const p = chain.then(async () => {
    const st = await load();
    const cur = st.byHost[host];
    if (cur && cur.referer === referer) {
      cur.t = Date.now();
      return;
    }
    const id = cur ? cur.id : st.nextId++;
    // Over the limit: drop the least recently used rules
    const evict = [];
    const hosts = Object.entries(st.byHost).filter(([h]) => h !== host).sort((x, y) => (x[1].t || 0) - (y[1].t || 0));
    while (hosts.length >= MAX_RULES) {
      const [h, r] = hosts.shift();
      evict.push(r.id);
      delete st.byHost[h];
    }
    const requestHeaders = [{ header: 'referer', operation: 'set', value: referer }];
    try {
      const origin = new URL(referer).origin;
      if (origin && origin !== 'null') requestHeaders.push({ header: 'origin', operation: 'set', value: origin });
    } catch { /* ignore */ }
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id, ...evict],
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          requestDomains: [host],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      }],
    });
    st.byHost[host] = { id, referer, t: Date.now() };
    await chrome.storage.session.set({ dnrState: st });
  });
  chain = p.catch((e) => console.warn('[headers]', e));
  return p;
}
