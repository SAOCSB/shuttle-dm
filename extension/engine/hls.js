// HLS (M3U8) downloads: parse master/media playlists → download segments in parallel (AES-128 decrypted
// automatically) → combine into MP4. Supports quality selection, separate audio renditions, fMP4
// segments, EXT-X-BYTERANGE, resume and live recording.

import { parseM3U8, encryptionOf, ivFor } from '../common/m3u8.js';
import { qualityLabel, sleep } from '../common/util.js';
import { Mp4Muxer } from '../common/mp4.js';
import { probeTs, looksLikePackedAudio, transmuxTs } from '../common/ts.js';
import { HttpError, FatalError, stallGuard } from './http.js';
import { readJson, writeJson, writeFile, fileSizes, readFile, appendWriter } from './opfs.js';
import { i18n, tp } from '../common/i18n.js';

const segName = (seq) => 's_' + String(seq).padStart(10, '0');
const initName = (i) => 'init_' + i;

export class HlsJob {
  constructor(o) {
    this.task = o.task;
    this.dirs = o.dirs;
    this.concurrency = Math.max(1, o.concurrency || 6);
    this.retries = o.retries ?? 6;
    this.limiter = o.limiter || null;
    this.beforeFetch = o.beforeFetch || null;
    this.onChange = o.onChange || (() => {});
    this.ac = new AbortController();
    if (o.signal) {
      if (o.signal.aborted) this.ac.abort(o.signal.reason);
      else o.signal.addEventListener('abort', () => this.ac.abort(o.signal.reason), { once: true });
    }
    this.stopAc = new AbortController();
    this.tracks = [];
    this.keyCache = new Map();
    this.received = 0;
    this.live = false;
    this.stopped = false;
    this.skipped = 0;
    this.note = '';
    this.lastMetaSave = 0;
  }

  get signal() {
    return this.ac.signal;
  }

  /** Live recording: stop and save */
  stop() {
    this.stopped = true;
    this.stopAc.abort();
  }

  async fetchResp(url, headers = {}) {
    await this.beforeFetch?.(url);
    const ac = new AbortController();
    const onAbort = () => ac.abort(this.signal.reason);
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(Object.assign(new Error(i18n('errNoResponse')), { stall: true })), 30000);
    try {
      const resp = await fetch(url, { headers, signal: ac.signal, credentials: 'include', cache: 'no-store' });
      if (!resp.ok) throw new HttpError(resp.status);
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

  async fetchText(url) {
    let attempt = 0;
    for (;;) {
      try {
        const resp = await this.fetchResp(url);
        try {
          return new TextDecoder().decode(await this.readBody(resp, () => {}, false));
        } finally {
          resp.release();
        }
      } catch (e) {
        if (this.signal.aborted || e.fatal || ++attempt > Math.min(this.retries, 4)) throw e;
        await sleep(600 * attempt, this.signal);
      }
    }
  }

  makeTrack(name, url, pl) {
    return {
      name,
      url,
      list: pl.segments.map((s) => ({ ...s })),
      keys: pl.keys,
      maps: pl.maps,
      endList: pl.endList,
      targetDuration: pl.targetDuration,
      dir: this.dirs[name],
      done: new Set(),
      skipped: new Set(),
      inflight: new Set(),
    };
  }

  async resolve() {
    const t = this.task;
    const meta = await readJson(this.dirs.root, 'meta.json');
    if (meta?.tracks?.length) {
      this.tracks = meta.tracks.map((m) => ({
        ...m,
        dir: this.dirs[m.name],
        done: new Set(),
        skipped: new Set(),
        inflight: new Set(),
      }));
      this.live = !this.tracks[0].endList;
      return;
    }
    let url = t.url;
    let pl = parseM3U8(await this.fetchText(url), url);
    let audioUri = t.hls.audioUri || null;
    if (pl.type === 'master') {
      const v = pickVariant(pl.variants, t.hls);
      if (!v) throw new FatalError(i18n('errNoVariants'));
      t.hls.variantUri = v.uri;
      if (!t.hls.quality) t.hls.quality = qualityLabel(v);
      t.hls.codecs = v.codecs || '';
      if (!audioUri && v.audio && !t.hls.noAudio) {
        const group = pl.media.filter((m) => m.type === 'AUDIO' && m.groupId === v.audio && m.uri);
        const pick = group.find((m) => m.default) || group.find((m) => m.autoselect) || group[0];
        if (pick) audioUri = pick.uri;
      }
      url = v.uri;
      pl = parseM3U8(await this.fetchText(url), url);
      if (pl.type !== 'media') throw new FatalError(i18n('errVariantParse'));
    }
    if (!pl.segments.length) throw new FatalError(i18n('errNoSegments'));
    const enc = encryptionOf(pl);
    if (enc === 'drm') throw new FatalError(i18n('drmVideoNote'));
    t.hls.encrypted = enc;
    this.tracks = [this.makeTrack('main', url, pl)];
    if (audioUri && audioUri !== url) {
      const apl = parseM3U8(await this.fetchText(audioUri), audioUri);
      if (apl.type === 'media' && apl.segments.length) {
        if (encryptionOf(apl) === 'drm') throw new FatalError(i18n('errDrmAudio'));
        this.tracks.push(this.makeTrack('audio', audioUri, apl));
        t.hls.audioUri = audioUri;
      }
    }
    this.live = !pl.endList;
    if (this.live) {
      // Live: start recording from the latest few segments
      for (const tr of this.tracks) tr.list = tr.list.slice(-3);
    }
    await this.saveMeta(true);
  }

  async saveMeta(force = false) {
    const now = Date.now();
    if (!force && now - this.lastMetaSave < (this.live ? 20000 : 3000)) return;
    this.lastMetaSave = now;
    await writeJson(this.dirs.root, 'meta.json', {
      tracks: this.tracks.map(({ name, url, list, keys, maps, endList, targetDuration }) => ({ name, url, list, keys, maps, endList, targetDuration })),
    });
  }

  stats() {
    let total = 0;
    let done = 0;
    let duration = 0;
    let doneDuration = 0;
    const main = this.tracks[0];
    for (const tr of this.tracks) {
      total += tr.list.length;
      done += tr.done.size + tr.skipped.size;
    }
    if (main) {
      for (const s of main.list) {
        duration += s.duration || 0;
        if (main.done.has(s.seq)) doneDuration += s.duration || 0;
      }
    }
    return { total, done, duration, doneDuration };
  }

  map(n = 100) {
    const main = this.tracks[0];
    if (!main || !main.list.length || this.live) return null;
    const out = new Array(n).fill(0);
    const len = main.list.length;
    main.list.forEach((s, i) => {
      if (!main.done.has(s.seq)) return;
      const a = (i / len) * n;
      const b = ((i + 1) / len) * n;
      for (let k = Math.floor(a); k < Math.min(n, Math.ceil(b)); k++) {
        out[k] += Math.min(b, k + 1) - Math.max(a, k);
      }
    });
    return out.map((x) => Math.min(1, Math.round(x * 100) / 100));
  }

  async run() {
    await this.resolve();
    this.task.hls.live = this.live;
    for (const tr of this.tracks) {
      const sizes = await fileSizes(tr.dir);
      for (const s of tr.list) {
        const sz = sizes.get(segName(s.seq));
        if (sz > 0) {
          tr.done.add(s.seq);
          this.received += sz;
        }
      }
      for (let i = 0; i < tr.maps.length; i++) {
        if (!(sizes.get(initName(i)) > 0)) await this.fetchInit(tr, i);
      }
    }
    this.onChange();
    if (this.live) await this.liveLoop();
    else await this.downloadPending();
    if (this.signal.aborted) throw this.signal.reason || new DOMException('Aborted', 'AbortError');
    await this.saveMeta(true);
    const st = this.stats();
    if (this.skipped) this.note = tp('noteSkipped', this.skipped);
    if (st.done === 0) throw new Error(i18n('errNoSegmentsDownloaded'));
  }

  async fetchInit(tr, i) {
    const m = tr.maps[i];
    const headers = m.byterange ? { Range: `bytes=${m.byterange.offset}-${m.byterange.offset + m.byterange.length - 1}` } : {};
    let attempt = 0;
    for (;;) {
      try {
        const resp = await this.fetchResp(m.uri, headers);
        let data;
        try {
          data = await this.readBody(resp, () => {}, false);
        } finally {
          resp.release();
        }
        if (m.byterange && resp.status === 200) data = data.subarray(m.byterange.offset, m.byterange.offset + m.byterange.length);
        await writeFile(tr.dir, initName(i), data);
        return;
      } catch (e) {
        if (this.signal.aborted || e.fatal || ++attempt > this.retries) throw e;
        await sleep(backoff(attempt), this.signal);
      }
    }
  }

  async downloadPending() {
    const jobs = [];
    for (const tr of this.tracks) {
      for (const s of tr.list) {
        if (!tr.done.has(s.seq) && !tr.skipped.has(s.seq) && !tr.inflight.has(s.seq)) jobs.push({ tr, s });
      }
    }
    if (!jobs.length) return;
    let idx = 0;
    let failure = null;
    const worker = async () => {
      while (idx < jobs.length && !this.signal.aborted && !failure) {
        const { tr, s } = jobs[idx++];
        tr.inflight.add(s.seq);
        try {
          await this.fetchSegment(tr, s);
        } catch (e) {
          if (!this.signal.aborted) failure = e;
          return;
        } finally {
          tr.inflight.delete(s.seq);
        }
        await this.saveMeta();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, jobs.length) }, worker));
    if (failure) throw failure;
  }

  async getKey(tr, index) {
    const k = tr.keys[index];
    if (!this.keyCache.has(k.uri)) {
      const p = (async () => {
        let attempt = 0;
        for (;;) {
          try {
            const resp = await this.fetchResp(k.uri);
            let buf;
            try {
              buf = await this.readBody(resp, () => {}, false);
            } finally {
              resp.release();
            }
            if (buf.byteLength !== 16) throw new FatalError(i18n('errKeyFormat', buf.byteLength));
            return await crypto.subtle.importKey('raw', buf, { name: 'AES-CBC' }, false, ['decrypt']);
          } catch (e) {
            if (this.signal.aborted || e.fatal || ++attempt > this.retries) throw e;
            await sleep(backoff(attempt), this.signal);
          }
        }
      })();
      this.keyCache.set(k.uri, p);
      p.catch(() => this.keyCache.delete(k.uri));
    }
    return this.keyCache.get(k.uri);
  }

  async readBody(resp, onBytes, limit = true) {
    const len = Number(resp.headers.get('content-length'));
    const reader = resp.body.getReader();
    const guard = stallGuard(resp.ac);
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await guard.race(reader.read());
        if (done) break;
        const rate = limit && this.limiter ? this.limiter.rate : 0;
        if (rate) {
          const step = Math.max(4096, Math.floor(rate / 8));
          for (let off = 0; off < value.byteLength; off += step) {
            const n = Math.min(step, value.byteLength - off);
            await this.limiter.take(n, this.signal);
            onBytes(n);
          }
        } else {
          onBytes(value.byteLength);
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (e) {
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      guard.dispose();
    }
    if (Number.isFinite(len) && len > 0 && !resp.headers.get('content-encoding') && total < len) {
      throw new Error(i18n('errSegmentIncomplete'));
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }

  async fetchSegment(tr, s) {
    const headers = s.byterange ? { Range: `bytes=${s.byterange.offset}-${s.byterange.offset + s.byterange.length - 1}` } : {};
    let attempt = 0;
    for (;;) {
      let counted = 0;
      try {
        const resp = await this.fetchResp(s.uri, headers);
        let data;
        try {
          data = await this.readBody(resp, (n) => {
            counted += n;
            this.received += n;
          });
        } finally {
          resp.release();
        }
        if (s.byterange && resp.status === 200) data = data.subarray(s.byterange.offset, s.byterange.offset + s.byterange.length);
        if (s.key >= 0) {
          const k = tr.keys[s.key];
          const key = await this.getKey(tr, s.key);
          try {
            data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(k, s.seq) }, key, data));
          } catch {
            throw new FatalError(i18n('errDecrypt'));
          }
        }
        await writeFile(tr.dir, segName(s.seq), data);
        tr.done.add(s.seq);
        return;
      } catch (e) {
        this.received -= counted;
        if (this.signal.aborted) throw e;
        if (e instanceof HttpError && (e.status === 404 || e.status === 410) && attempt >= 2) {
          // A few missing segments are skipped (too many fail the download)
          tr.skipped.add(s.seq);
          this.skipped++;
          const limit = Math.max(3, Math.ceil(tr.list.length * 0.02));
          if (this.skipped > limit) throw new Error(i18n('errTooManySkipped', e.message));
          return;
        }
        if (e.fatal && !(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e;
        if (++attempt > this.retries) throw e;
        await sleep(backoff(attempt), this.signal);
      }
    }
  }

  async liveLoop() {
    let failures = 0;
    while (!this.stopped && !this.signal.aborted) {
      await this.downloadPending();
      if (this.tracks.every((tr) => tr.endList) || this.stopped) break;
      const wait = Math.max(1000, (this.tracks[0].targetDuration || 4) * 500);
      try {
        await sleep(wait, AbortSignal.any([this.signal, this.stopAc.signal]));
      } catch {
        if (this.signal.aborted) break;
      }
      if (this.stopped) break;
      try {
        for (const tr of this.tracks) await this.refresh(tr);
        failures = 0;
        this.onChange();
      } catch (e) {
        if (this.signal.aborted) break;
        if (++failures > 6) {
          this.note = i18n('noteLiveEnded');
          break;
        }
      }
      await this.saveMeta();
    }
    // After stopping a recording, wait for segments still downloading
    await this.downloadPending();
  }

  async refresh(tr) {
    const pl = parseM3U8(await this.fetchText(tr.url), tr.url);
    if (pl.type !== 'media') return;
    const lastSeq = tr.list.length ? tr.list[tr.list.length - 1].seq : -1;
    for (const s of pl.segments) {
      if (s.seq <= lastSeq) continue;
      const seg = { ...s };
      if (s.key >= 0) seg.key = remapIndex(tr.keys, pl.keys[s.key], (a, b) => a.uri === b.uri && a.iv === b.iv && a.method === b.method);
      if (s.map >= 0) {
        const before = tr.maps.length;
        seg.map = remapIndex(tr.maps, pl.maps[s.map], (a, b) => a.uri === b.uri);
        if (tr.maps.length > before) await this.fetchInit(tr, seg.map);
      }
      tr.list.push(seg);
    }
    tr.endList = pl.endList;
    tr.targetDuration = pl.targetDuration || tr.targetDuration;
  }
}

function stripQuery(u) {
  return String(u || '').split(/[?#]/)[0];
}

/** Picks the variant: exact URL first, then bandwidth/resolution/codecs (URLs often carry one-time tokens), then path */
function pickVariant(variants, hls) {
  const want = hls.variantUri;
  let v = want && variants.find((x) => x.uri === want);
  const vi = hls.variantInfo;
  if (!v && vi) {
    v = variants.find((x) => x.bandwidth === vi.bandwidth && x.height === vi.height && x.codecs === vi.codecs) ||
      variants.find((x) => x.height === vi.height && x.bandwidth === vi.bandwidth) ||
      variants.find((x) => vi.height && x.height === vi.height);
  }
  if (!v && want) v = variants.find((x) => stripQuery(x.uri) === stripQuery(want));
  return v || variants[0];
}

function remapIndex(arr, item, eq) {
  const i = arr.findIndex((x) => eq(x, item));
  if (i >= 0) return i;
  arr.push(item);
  return arr.length - 1;
}

function backoff(attempt) {
  return Math.min(20000, 600 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}

async function segmentFiles(tr) {
  const out = [];
  for (const s of tr.list) {
    if (!tr.done.has(s.seq)) continue;
    const f = await readFile(tr.dir, segName(s.seq));
    if (f && f.size) out.push({ seg: s, file: f });
  }
  return out;
}

async function sameBytes(files) {
  if (files.length < 2) return true;
  const first = new Uint8Array(await files[0].arrayBuffer());
  for (const f of files.slice(1)) {
    const b = new Uint8Array(await f.arrayBuffer());
    if (b.length !== first.length) return false;
    for (let i = 0; i < b.length; i++) if (b[i] !== first[i]) return false;
  }
  return true;
}

/** Adds one track's segments to the Mp4Muxer. Returns false if it can't be converted (fall back). */
async function addTrackToMuxer(muxer, tr, segs, only, muxjs, signal, onProgress) {
  if (tr.maps.length) {
    const inits = [];
    for (let i = 0; i < tr.maps.length; i++) inits.push(await readFile(tr.dir, initName(i)));
    if (inits.some((f) => !f) || !(await sameBytes(inits))) return { ok: false, reason: i18n('reasonInitMismatch') };
    const input = muxer.addInput(new Uint8Array(await inits[0].arrayBuffer()), { only });
    for (let i = 0; i < segs.length; i++) {
      if (signal?.aborted) throw signal.reason;
      const u8 = new Uint8Array(await segs[i].file.arrayBuffer());
      const src = muxer.addSource(segs[i].file);
      muxer.addFragments(input, u8, src, 0);
      onProgress?.((i + 1) / segs.length);
    }
    return { ok: true };
  }
  const head = new Uint8Array(await segs[0].file.slice(0, 256 * 1024).arrayBuffer());
  if (!looksLikePackedAudio(head)) {
    const probe = probeTs(head);
    if (!probe.isTs) return { ok: false, reason: i18n('reasonUnknownFormat') };
    if (!probe.convertible) return { ok: false, reason: probe.reason };
  }
  const writer = await appendWriter(tr.dir, 'frag.bin');
  const srcIndex = muxer.addSource(null);
  let input;
  try {
    input = await transmuxTs({
      muxjs,
      readSegment: async (i) => new Uint8Array(await segs[i].file.arrayBuffer()),
      count: segs.length,
      durations: segs.map((x) => x.seg.duration),
      discontinuities: segs.map((x) => x.seg.discontinuity),
      append: (u8) => writer.append(u8),
      muxer: {
        addInput: (init) => muxer.addInput(init, { only }),
        extendInput: (inp, init) => muxer.extendInput(inp, init),
        addFragments: (inp, u8, src, at) => muxer.addFragments(inp, u8, src, at),
      },
      srcIndex,
      signal,
      onProgress: (d, n) => onProgress?.(d / n),
    });
  } catch (e) {
    await writer.abort();
    throw e;
  }
  muxer.setSource(srcIndex, await writer.close());
  if (!input) return { ok: false, reason: i18n('reasonNoOutput') };
  return { ok: true };
}

/**
 * Builds the final file: a standard MP4 when possible, otherwise the TS / fMP4 segments joined as they are.
 * @returns {Promise<{blob: Blob, ext: string, mime: string, note: string}>}
 */
export async function buildHlsOutput({ tracks, format, muxjs, signal, onProgress }) {
  const main = tracks[0];
  const audio = tracks[1] || null;
  const mainSegs = await segmentFiles(main);
  if (!mainSegs.length) throw new Error(i18n('errNoSegmentsDownloaded'));
  const audioSegs = audio ? await segmentFiles(audio) : [];
  const isFmp4 = main.maps.length > 0;

  const concatFallback = async (note) => {
    if (isFmp4) {
      const init = await readFile(main.dir, initName(0));
      return { blob: new Blob([init, ...mainSegs.map((x) => x.file)], { type: 'video/mp4' }), ext: 'mp4', mime: 'video/mp4', note };
    }
    const head = new Uint8Array(await mainSegs[0].file.slice(0, 16).arrayBuffer());
    if (looksLikePackedAudio(head)) {
      return { blob: new Blob(mainSegs.map((x) => x.file), { type: 'audio/aac' }), ext: 'aac', mime: 'audio/aac', note };
    }
    return { blob: new Blob(mainSegs.map((x) => x.file), { type: 'video/mp2t' }), ext: 'ts', mime: 'video/mp2t', note };
  };

  if (format === 'ts' && !isFmp4 && !audio) return concatFallback('');

  const muxer = new Mp4Muxer();
  const weight = audio ? 0.8 : 1;
  try {
    const r = await addTrackToMuxer(muxer, main, mainSegs, null, muxjs, signal, (p) => onProgress?.(p * weight));
    if (!r.ok) {
      return concatFallback(i18n('noteKeptOriginal', r.reason));
    }
    let note = '';
    if (audio && audioSegs.length) {
      const hasAudio = muxer.summary().some((x) => x.type === 'audio');
      if (!hasAudio) {
        const ra = await addTrackToMuxer(muxer, audio, audioSegs, 'soun', muxjs, signal, (p) => onProgress?.(weight + p * (1 - weight)));
        if (!ra.ok) note = i18n('noteAudioNotMerged', ra.reason);
      }
    }
    const kinds = muxer.summary();
    const hasVideo = kinds.some((x) => x.type === 'video');
    const { blob } = muxer.build(hasVideo ? 'video/mp4' : 'audio/mp4');
    onProgress?.(1);
    return { blob, ext: hasVideo ? 'mp4' : 'm4a', mime: hasVideo ? 'video/mp4' : 'audio/mp4', note };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e?.message?.includes('DRM')) throw e;
    console.warn('[hls] mp4 mux failed, fallback', e);
    return concatFallback(i18n('noteMp4Failed', e.message));
  }
}
