// Multi-connection downloads with dynamic splitting:
// - the first request doubles as the probe (Range: bytes=0-) and starts receiving data at once;
// - files that support Range are split into segments downloaded in parallel;
// - when a connection finishes, it takes over the second half of the largest remaining segment;
// - data is written to OPFS in 4 MB piece files, so pauses, crashes and restarts resume from what was committed.

import { baseMime, parseContentDisposition, parseContentRange, sleep, isAbortError } from '../common/util.js';
import { clearDir } from './opfs.js';
import { i18n } from '../common/i18n.js';

export const PIECE_SIZE = 4 << 20;
const MIN_SEG = 512 << 10;
const STEAL_MIN = 2 << 20;
const PIECE_RE = /^p_(\d{15})$/;
const pieceName = (start) => 'p_' + String(start).padStart(15, '0');

// HTTP status codes with their own explanation (message key http<status>)
const KNOWN_STATUS = new Set([400, 401, 403, 404, 405, 410, 416, 429, 451, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message || (KNOWN_STATUS.has(status) ? i18n(`http${status}`) : i18n('httpError', status)));
    this.status = status;
    this.fatal = [400, 401, 403, 404, 405, 410, 451].includes(status);
  }
}

export class FatalError extends Error {
  constructor(message) {
    super(message);
    this.fatal = true;
  }
}

export const STALL_MS = 15000;

/**
 * Connection watchdog: aborts a connection that receives no data for a while and makes the read fail.
 * When a server drops a connection, Chrome occasionally fails the fetch but never settles reader.read().
 */
export function stallGuard(ac, ms = STALL_MS) {
  // Only time the wait for network data (during race); waiting for the speed limiter or the disk doesn't count as stalled
  let armedAt = 0;
  let rejectFn;
  const tripped = new Promise((_, reject) => { rejectFn = reject; });
  tripped.catch(() => {});
  const timer = setInterval(() => {
    if (!armedAt || Date.now() - armedAt <= ms) return;
    clearInterval(timer);
    const err = new Error(i18n('errTimeoutNoData', Math.round(ms / 1000)));
    err.stall = true;
    try { ac.abort(err); } catch { /* ignore */ }
    rejectFn(err);
  }, Math.min(2000, ms / 4));
  return {
    async race(p) {
      armedAt = Date.now();
      try {
        return await Promise.race([p, tripped]);
      } finally {
        armedAt = 0;
      }
    },
    dispose() { clearInterval(timer); },
  };
}

export function responseInfo(resp) {
  const h = resp.headers;
  const enc = (h.get('content-encoding') || '').toLowerCase();
  const encoded = !!enc && enc !== 'identity';
  const cr = parseContentRange(h.get('content-range'));
  const lenHeader = h.get('content-length');
  const len = lenHeader != null ? Number(lenHeader) : NaN;
  let size = null;
  let resumable = false;
  if (resp.status === 206 && cr) {
    size = cr.total;
    resumable = !encoded;
  } else if (resp.status === 200) {
    size = !encoded && Number.isFinite(len) ? len : null;
  }
  return {
    status: resp.status,
    finalUrl: resp.url,
    mime: baseMime(h.get('content-type')),
    size,
    resumable,
    rangeStart: cr ? cr.start : 0,
    filename: parseContentDisposition(h.get('content-disposition')),
    etag: h.get('etag') || '',
    lastModified: h.get('last-modified') || '',
  };
}

export async function listPieces(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    const m = PIECE_RE.exec(name);
    if (!m || h.kind !== 'file') continue;
    const f = await h.getFile();
    if (f.size > 0) out.push({ start: Number(m[1]), size: f.size, handle: h });
  }
  return out.sort((a, b) => a.start - b.start);
}

function coverage(pieces, size = null) {
  const out = [];
  for (const p of pieces) {
    const s = p.start;
    let e = p.start + p.size;
    if (size != null) {
      if (s >= size) continue;
      e = Math.min(e, size);
    }
    const last = out[out.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

function gapsOf(covered, size) {
  const gaps = [];
  let pos = 0;
  for (const c of covered) {
    if (c.start > pos) gaps.push({ start: pos, end: Math.min(c.start, size) });
    pos = Math.max(pos, c.end);
    if (pos >= size) break;
  }
  if (pos < size) gaps.push({ start: pos, end: size });
  return gaps.filter((g) => g.end > g.start);
}

/** Joins the piece files into one Blob (references to disk, not memory). */
export async function buildBlobFromPieces(dir, size, type = 'application/octet-stream') {
  const pieces = await listPieces(dir);
  const parts = [];
  let pos = 0;
  for (const p of pieces) {
    const file = await p.handle.getFile();
    const s = p.start;
    const e = s + file.size;
    if (e <= pos) continue;
    if (s > pos) throw new Error(i18n('errIncompleteAt', pos));
    let part = s < pos ? file.slice(pos - s) : file;
    if (size != null && e > size) part = part.slice(0, part.size - (e - size));
    parts.push(part);
    pos = Math.min(e, size ?? e);
    if (size != null && pos >= size) break;
  }
  if (size != null && pos < size) throw new Error(i18n('errIncompleteSize', pos, size));
  return new Blob(parts, { type: type || 'application/octet-stream' });
}

export class HttpJob {
  /**
   * @param o.url
   * @param o.dir         OPFS directory
   * @param o.threads     number of connections
   * @param o.retries     retries per segment
   * @param o.limiter     global speed limiter
   * @param o.signal      abort signal (pause / remove)
   * @param o.info        what the last probe found (for resuming)
   * @param o.beforeFetch async (url) => void   called before each request (sets the Referer rule)
   * @param o.onInfo      (info) => void        called with the response headers; may throw to abort
   */
  constructor(o) {
    this.url = o.url;
    this.dir = o.dir;
    this.threads = Math.max(1, o.threads || 8);
    this.retries = o.retries ?? 6;
    this.limiter = o.limiter || null;
    this.info = o.info || null;
    this.beforeFetch = o.beforeFetch || null;
    this.onInfo = o.onInfo || null;
    this.ac = new AbortController();
    this.outer = o.signal || null;
    if (this.outer) {
      if (this.outer.aborted) this.ac.abort(this.outer.reason);
      else this.outer.addEventListener('abort', () => this.ac.abort(this.outer.reason), { once: true });
    }
    this.size = this.info?.size ?? null;
    this.resumable = false;
    this.received = 0;
    this.baseline = [];
    this.segs = [];
    this.active = new Set();
    this.queue = [];
    this.fatal = null;
  }

  get signal() {
    return this.ac.signal;
  }

  /** Sends a request; the response carries its own AbortController (resp.ac) to close it early */
  async request(from, to, timeoutMs = 30000) {
    await this.beforeFetch?.(this.url);
    const headers = {};
    if (from != null) headers.Range = to != null ? `bytes=${from}-${to}` : `bytes=${from}-`;
    const ac = new AbortController();
    const onAbort = () => ac.abort(this.signal.reason);
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(Object.assign(new Error(i18n('errNoResponse')), { stall: true })), timeoutMs);
    try {
      const resp = await fetch(this.url, { headers, signal: ac.signal, credentials: 'include', cache: 'no-store', redirect: 'follow' });
      resp.ac = ac;
      resp.release = () => this.signal.removeEventListener('abort', onAbort);
      return resp;
    } catch (e) {
      this.signal.removeEventListener('abort', onAbort);
      throw ac.signal.aborted && !this.signal.aborted && ac.signal.reason ? ac.signal.reason : e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The first request, with retries */
  async firstRequest(from) {
    let attempt = 0;
    for (;;) {
      try {
        let resp = await this.request(from, null);
        if (resp.status === 416 && from === 0) {
          // Empty file or Range not accepted: use a plain request
          resp.release();
          resp = await this.request(null, null);
        }
        if (resp.status !== 200 && resp.status !== 206) {
          resp.release();
          throw new HttpError(resp.status);
        }
        return resp;
      } catch (e) {
        if (this.signal.aborted) throw e;
        if (e.fatal || ++attempt > this.retries) throw e;
        await sleep(backoff(attempt), this.signal);
      }
    }
  }

  async run() {
    const prev = this.info;
    const pieces = await listPieces(this.dir);
    let covered = coverage(pieces, prev?.size ?? null);
    let coveredBytes = covered.reduce((a, c) => a + c.end - c.start, 0);

    if (prev?.resumable && prev.size != null && coveredBytes >= prev.size) {
      this.size = prev.size;
      this.resumable = true;
      this.received = prev.size;
      this.baseline = covered;
      return;
    }
    let from = 0;
    if (prev?.resumable && prev.size && coveredBytes > 0) {
      from = gapsOf(covered, prev.size)[0].start;
    } else if (coveredBytes > 0) {
      await clearDir(this.dir);
      covered = [];
      coveredBytes = 0;
    }

    let resp = await this.firstRequest(from);
    let info = responseInfo(resp);

    if (coveredBytes > 0) {
      // There is downloaded data: check the remote file is still the same (size, ETag, Last-Modified), otherwise start over
      const sameFile = info.status === 206 && info.rangeStart === from && info.size === prev.size &&
        (!prev.etag || !info.etag || prev.etag === info.etag) &&
        (!prev.lastModified || !info.lastModified || prev.lastModified === info.lastModified);
      if (!sameFile) {
        await clearDir(this.dir);
        covered = [];
        coveredBytes = 0;
        if (from > 0) {
          try { resp.body?.cancel(); } catch { /* ignore */ }
          resp.release();
          from = 0;
          resp = await this.firstRequest(0);
          info = responseInfo(resp);
        }
      }
    }

    this.resumable = info.resumable;
    this.size = info.size;
    this.info = info;
    try {
      this.onInfo?.(info);
    } catch (e) {
      try { resp.body?.cancel(); } catch { /* ignore */ }
      resp.release();
      throw e;
    }

    if (!info.resumable || info.size == null) {
      // Single connection: no Range support or unknown size
      this.received = from;
      this.baseline = from > 0 ? covered : [];
      const seg = { start: from, end: info.size ?? Infinity, pos: from };
      this.segs = [seg];
      this.active.add(seg);
      try {
        await this.runSegment(seg, resp);
      } finally {
        this.active.delete(seg);
      }
      if (this.size == null) this.size = seg.pos;
      return;
    }

    // Multiple connections
    this.baseline = covered;
    this.received = coveredBytes;
    let segs = gapsOf(covered, info.size).map((g) => ({ start: g.start, end: g.end, pos: g.start }));
    segs = splitToCount(segs, this.threads);
    this.segs = segs.slice();
    const first = segs[0];
    this.queue = segs.slice(1);
    const workers = [this.worker(first, resp)];
    for (let i = 1; i < this.threads; i++) workers.push(this.worker(null, null));
    const results = await Promise.allSettled(workers);
    if (this.fatal) throw this.fatal;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (this.signal.aborted) throw this.signal.reason || new DOMException('Aborted', 'AbortError');
    const left = this.segs.reduce((a, s) => a + Math.max(0, s.end - s.pos), 0);
    if (left > 0) throw new Error(i18n('errNotFinished'));
  }

  async worker(seg, resp) {
    while (!this.signal.aborted) {
      if (!seg) seg = this.queue.shift() || this.steal();
      if (!seg) return;
      this.active.add(seg);
      try {
        await this.runSegment(seg, resp);
      } catch (e) {
        if (!this.signal.aborted) {
          if (e instanceof HttpError && [403, 429, 503, 509].includes(e.status) && this.active.size > 1) {
            // The server limits concurrent connections: this one stops and the others take over the rest
            this.queue.push(seg);
            this.limited = (this.limited || 0) + 1;
            return;
          }
          this.fatal = e;
          this.ac.abort(e);
        }
        throw e;
      } finally {
        this.active.delete(seg);
      }
      seg = null;
      resp = null;
    }
  }

  /** Dynamic splitting: takes the second half of the active segment with the most left */
  steal() {
    let best = null;
    for (const s of this.active) {
      const rem = s.end - s.pos;
      if (rem >= STEAL_MIN && (!best || rem > best.end - best.pos)) best = s;
    }
    if (!best) return null;
    const mid = best.pos + Math.floor((best.end - best.pos) / 2);
    const seg = { start: mid, end: best.end, pos: mid };
    best.end = mid;
    this.segs.push(seg);
    return seg;
  }

  async runSegment(seg, resp) {
    let attempt = 0;
    while (seg.pos < seg.end && !this.signal.aborted) {
      let writer = null;
      let reader = null;
      let pieceLen = 0;
      let current = resp;
      let ac = resp?.ac || null;
      let guard = ac ? stallGuard(ac) : null;
      try {
        if (!resp) {
          seg.stage = 'fetch';
          const r = await this.request(seg.pos, this.resumable && Number.isFinite(seg.end) ? seg.end - 1 : null);
          current = r;
          ac = r.ac;
          guard = stallGuard(ac);
          resp = r;
          if (!this.resumable && seg.pos > 0) throw new Error(i18n('errNoResume'));
          if (this.resumable) {
            if (resp.status !== 206) throw new HttpError(resp.status, resp.status === 200 ? i18n('errNoMoreRanges') : undefined);
            const cr = parseContentRange(resp.headers.get('content-range'));
            if (!cr || cr.start !== seg.pos) throw new Error(i18n('errBadRange'));
            if (this.size != null && cr.total != null && cr.total !== this.size) throw new FatalError(i18n('errRemoteChanged'));
          } else if (resp.status !== 200) {
            throw new HttpError(resp.status);
          }
        }
        reader = resp.body.getReader();
        resp = null;
        let finished = false;
        for (;;) {
          seg.stage = 'read';
          const { done, value } = await guard.race(reader.read());
          if (done) { finished = true; break; }
          // With a speed limit, cut large chunks into small ones so progress and speed update smoothly
          const rate = this.limiter?.rate || 0;
          const step = rate ? Math.max(4096, Math.floor(rate / 8)) : value.byteLength;
          for (let off = 0; off < value.byteLength; off += step) {
            const remaining = seg.end - seg.pos; // another connection may have taken the second half
            if (remaining <= 0) break;
            let part = value.subarray(off, Math.min(value.byteLength, off + step));
            if (part.byteLength > remaining) part = part.subarray(0, remaining);
            if (rate) await this.limiter.take(part.byteLength, this.signal);
            if (!writer) {
              const fh = await this.dir.getFileHandle(pieceName(seg.pos), { create: true });
              writer = await fh.createWritable();
              pieceLen = 0;
            }
            seg.stage = 'write';
            await writer.write(part);
            seg.pos += part.byteLength;
            pieceLen += part.byteLength;
            this.received += part.byteLength;
            // When resumable, progress resets the retry count; when not, every failure restarts from zero, so retries must add up or it could loop forever
            if (this.resumable) attempt = 0;
            if (pieceLen >= PIECE_SIZE) {
              await writer.close();
              writer = null;
            }
          }
          if (seg.pos >= seg.end) break;
        }
        if (!finished) {
          // Read enough (another connection may have taken the rest): drop the rest of the transfer and free the connection
          reader.cancel().catch(() => {});
          ac?.abort();
        }
        if (writer) {
          seg.stage = 'commit';
          await writer.close();
          writer = null;
        }
        if (seg.pos < seg.end) {
          if (!Number.isFinite(seg.end)) break; // unknown size: done when the stream ends
          throw new Error(i18n('errConnectionDropped'));
        }
      } catch (e) {
        try { reader?.cancel().catch(() => {}); } catch { /* ignore */ }
        try { ac?.abort(); } catch { /* ignore */ }
        if (writer) {
          // Commit what was received so a resume can reuse it
          try { await writer.close(); } catch { /* ignore */ }
          writer = null;
        }
        resp = null;
        if (this.signal.aborted) return;
        if (e.fatal || e?.name === 'QuotaExceededError') throw e;
        attempt++;
        seg.attempt = attempt;
        seg.lastError = String(e?.message || e);
        if (attempt > this.retries) throw e;
        if (!this.resumable) {
          // Not resumable: the only option is to start over
          await clearDir(this.dir);
          this.received -= seg.pos - seg.start;
          seg.pos = seg.start = 0;
        }
        seg.stage = 'sleep';
        try {
          await sleep(backoff(attempt), this.signal);
        } catch {
          return;
        }
      } finally {
        guard?.dispose();
        current?.release?.();
      }
    }
  }

  /** Progress map: completed ranges mapped onto n cells (0–1) */
  map(n = 100) {
    if (!this.size || !Number.isFinite(this.size)) return null;
    const out = new Array(n).fill(0);
    const bucket = this.size / n;
    const add = (s, e) => {
      if (e <= s) return;
      let i = Math.floor(s / bucket);
      while (s < e && i < n) {
        const be = Math.min(e, (i + 1) * bucket);
        out[i] += (be - s) / bucket;
        s = be;
        i++;
      }
    };
    for (const c of this.baseline) add(c.start, c.end);
    for (const s of this.segs) add(s.start, Math.min(s.pos, s.end));
    return out.map((x) => Math.min(1, Math.round(x * 100) / 100));
  }

  connections() {
    return [...this.active].map((s) => ({ start: s.start, pos: s.pos, end: Number.isFinite(s.end) ? s.end : null }));
  }
}

function splitToCount(segs, count) {
  segs = segs.slice();
  while (segs.length < count) {
    let bi = -1;
    for (let i = 0; i < segs.length; i++) if (bi < 0 || segs[i].end - segs[i].pos > segs[bi].end - segs[bi].pos) bi = i;
    const b = segs[bi];
    if (!b || b.end - b.pos < MIN_SEG * 2) break;
    const mid = b.pos + Math.floor((b.end - b.pos) / 2);
    const n = { start: mid, end: b.end, pos: mid };
    b.end = mid;
    segs.splice(bi + 1, 0, n);
  }
  return segs;
}

function backoff(attempt) {
  return Math.min(30000, 800 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}

export { isAbortError };
