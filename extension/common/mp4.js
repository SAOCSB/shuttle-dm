// ISO BMFF (MP4) parsing and remuxing.
// Combines fragmented MP4 (HLS fMP4 segments, TS converted by mux.js, separate DASH audio/video
// tracks) into one standard MP4 file (not fragmented, moov first, so it opens and seeks instantly).
// Media data never passes through memory: the output is a Blob made of slices of other Blobs.

import { i18n } from './i18n.js';

export class Mp4Error extends Error {}

function dv(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

function fourcc(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

export function readBoxHeader(u8, off, end = u8.length) {
  if (off + 8 > end) return null;
  const v = dv(u8);
  let size = v.getUint32(off);
  const type = fourcc(u8, off + 4);
  let header = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = v.getUint32(off + 8) * 2 ** 32 + v.getUint32(off + 12);
    header = 16;
  } else if (size === 0) {
    size = end - off;
  }
  if (size < header) return null;
  return { type, start: off, size, header, end: off + size };
}

export function* iterBoxes(u8, start = 0, end = u8.length) {
  let off = start;
  while (off + 8 <= end) {
    const b = readBoxHeader(u8, off, end);
    if (!b) return;
    yield b;
    if (b.end > end) return;
    off = b.end;
  }
}

export function findBox(u8, start, end, type) {
  for (const b of iterBoxes(u8, start, end)) if (b.type === type) return b;
  return null;
}

function inner(b) {
  return [b.start + b.header, b.end];
}

function child(u8, parent, type) {
  if (!parent) return null;
  const [s, e] = inner(parent);
  return findBox(u8, s, e, type);
}

/** Parses an initialization segment (ftyp+moov) and returns its tracks. */
export function parseInit(u8) {
  const v = dv(u8);
  const moov = findBox(u8, 0, u8.length, 'moov');
  if (!moov) throw new Mp4Error(i18n('errNoMoovInit'));
  const [m0, m1] = inner(moov);
  const trex = new Map();
  const mvex = findBox(u8, m0, m1, 'mvex');
  if (mvex) {
    for (const b of iterBoxes(u8, ...inner(mvex))) {
      if (b.type !== 'trex') continue;
      const p = b.start + b.header + 4;
      trex.set(v.getUint32(p), {
        sdi: v.getUint32(p + 4),
        duration: v.getUint32(p + 8),
        size: v.getUint32(p + 12),
        flags: v.getUint32(p + 16),
      });
    }
  }
  const hasPssh = !!findBox(u8, m0, m1, 'pssh');
  const fragmented = !!mvex;
  const tracks = [];
  for (const b of iterBoxes(u8, m0, m1)) {
    if (b.type !== 'trak') continue;
    const tkhd = child(u8, b, 'tkhd');
    const mdia = child(u8, b, 'mdia');
    const mdhd = child(u8, mdia, 'mdhd');
    const hdlr = child(u8, mdia, 'hdlr');
    const minf = child(u8, mdia, 'minf');
    const stbl = child(u8, minf, 'stbl');
    const stsd = child(u8, stbl, 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;
    const tv = u8[tkhd.start + tkhd.header];
    const trackId = v.getUint32(tkhd.start + tkhd.header + (tv === 1 ? 20 : 12));
    const width = v.getUint32(tkhd.end - 8) / 65536;
    const height = v.getUint32(tkhd.end - 4) / 65536;
    const mv = u8[mdhd.start + mdhd.header];
    const mbase = mdhd.start + mdhd.header + 4 + (mv === 1 ? 16 : 8);
    const timescale = v.getUint32(mbase);
    const language = v.getUint16(mbase + 4 + (mv === 1 ? 8 : 4));
    const handler = fourcc(u8, hdlr.start + hdlr.header + 8);
    const entry = readBoxHeader(u8, stsd.start + stsd.header + 8, stsd.end);
    const codec = entry ? entry.type : '';
    let mhd = null;
    for (const t of ['vmhd', 'smhd', 'sthd', 'nmhd', 'hmhd']) {
      mhd = child(u8, minf, t);
      if (mhd) break;
    }
    const dinf = child(u8, minf, 'dinf');
    let elstMediaTime = null;
    const elst = child(u8, child(u8, b, 'edts'), 'elst');
    if (elst) {
      const ev = u8[elst.start + elst.header];
      const n = v.getUint32(elst.start + elst.header + 4);
      let p = elst.start + elst.header + 8;
      for (let i = 0; i < n && p < elst.end; i++) {
        const mt = ev === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
        p += ev === 1 ? 20 : 12;
        if (mt >= 0) { elstMediaTime = mt; break; }
      }
    }
    tracks.push({
      trackId,
      handler,
      timescale,
      language,
      width,
      height,
      codec,
      encrypted: codec === 'encv' || codec === 'enca',
      trex: trex.get(trackId) || null,
      elstMediaTime,
      raw: {
        hdlr: u8.slice(hdlr.start, hdlr.end),
        mhd: mhd ? u8.slice(mhd.start, mhd.end) : null,
        dinf: dinf ? u8.slice(dinf.start, dinf.end) : null,
        stsd: u8.slice(stsd.start, stsd.end),
      },
      stbl: stbl ? u8.slice(stbl.start, stbl.end) : null,
    });
  }
  return { tracks, hasPssh, fragmented };
}

/** Parses the sample tables of a regular (non-fragmented) MP4 into runs per chunk, shaped like parseMoof's output. */
export function progressiveRuns(track) {
  const u8 = track.stbl;
  if (!u8) return [];
  const v = dv(u8);
  const [s0, s1] = [readBoxHeader(u8, 0).header, u8.length];
  const box = (t) => findBox(u8, s0, s1, t);
  const body = (b) => b.start + b.header + 4; // skip version/flags

  const stsz = box('stsz') || box('stz2');
  const stco = box('stco');
  const co64 = box('co64');
  const stsc = box('stsc');
  const stts = box('stts');
  if (!stsz || !(stco || co64) || !stsc || !stts) throw new Mp4Error(i18n('errSampleTable'));

  let p = body(stsz);
  let sizes;
  if (stsz.type === 'stsz') {
    const fixed = v.getUint32(p);
    const n = v.getUint32(p + 4);
    sizes = new Uint32Array(n);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < n; i++) sizes[i] = v.getUint32(p + 8 + i * 4);
  } else {
    throw new Mp4Error(i18n('errStz2'));
  }
  const n = sizes.length;

  const durs = new Uint32Array(n);
  p = body(stts);
  let k = 0;
  for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) {
    const c = v.getUint32(p + 4 + e * 8);
    const d = v.getUint32(p + 8 + e * 8);
    for (let i = 0; i < c && k < n; i++) durs[k++] = d;
  }

  const ctos = new Int32Array(n);
  const ctts = box('ctts');
  if (ctts) {
    const ver = u8[ctts.start + ctts.header];
    p = body(ctts);
    k = 0;
    for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) {
      const c = v.getUint32(p + 4 + e * 8);
      const o = ver === 1 ? v.getInt32(p + 8 + e * 8) : v.getUint32(p + 8 + e * 8);
      for (let i = 0; i < c && k < n; i++) ctos[k++] = o;
    }
  }

  const flags = new Uint32Array(n);
  const stss = box('stss');
  if (stss) {
    flags.fill(0x00010000);
    p = body(stss);
    for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) {
      const idx = v.getUint32(p + 4 + e * 4) - 1;
      if (idx >= 0 && idx < n) flags[idx] = 0;
    }
  }

  const offsets = [];
  if (co64) {
    p = body(co64);
    for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) offsets.push(v.getUint32(p + 4 + e * 8) * 2 ** 32 + v.getUint32(p + 8 + e * 8));
  } else {
    p = body(stco);
    for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) offsets.push(v.getUint32(p + 4 + e * 4));
  }

  const map = [];
  p = body(stsc);
  for (let e = 0, cnt = v.getUint32(p); e < cnt; e++) {
    map.push({ first: v.getUint32(p + 4 + e * 12), per: v.getUint32(p + 8 + e * 12), sdi: v.getUint32(p + 12 + e * 12) });
  }

  const runs = [];
  let sample = 0;
  let dts = 0;
  for (let c = 0; c < offsets.length && sample < n; c++) {
    let m = map[0];
    for (const x of map) {
      if (x.first <= c + 1) m = x;
      else break;
    }
    const count = Math.min(m.per, n - sample);
    if (!count) continue;
    let size = 0;
    for (let i = 0; i < count; i++) size += sizes[sample + i];
    runs.push({
      trackId: track.trackId,
      dts,
      sdi: m.sdi || 1,
      offset: offsets[c],
      size,
      count,
      durs: durs.subarray(sample, sample + count),
      sizes: sizes.subarray(sample, sample + count),
      flags: flags.subarray(sample, sample + count),
      ctos: ctos.subarray(sample, sample + count),
    });
    for (let i = 0; i < count; i++) dts += durs[sample + i];
    sample += count;
  }
  return runs;
}

/**
 * Parses one moof and returns the samples of each trun in it.
 * @param u8 buffer that contains the moof
 * @param moof the moof box header (from readBoxHeader)
 * @param absBase absolute offset of byte 0 of the buffer in the source file
 */
export function parseMoof(u8, moof, absBase, trexOf) {
  const v = dv(u8);
  const runs = [];
  const moofAbs = absBase + moof.start;
  let prevTrafDataEnd = null;
  for (const traf of iterBoxes(u8, ...inner(moof))) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(u8, traf, 'tfhd');
    if (!tfhd) continue;
    let p = tfhd.start + tfhd.header;
    const tf = v.getUint32(p) & 0xffffff;
    p += 4;
    const trackId = v.getUint32(p);
    p += 4;
    const trex = trexOf(trackId) || {};
    let baseOffset = null;
    if (tf & 0x01) { baseOffset = v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4); p += 8; }
    let sdi = trex.sdi || 1;
    if (tf & 0x02) { sdi = v.getUint32(p); p += 4; }
    let defDur = trex.duration || 0;
    if (tf & 0x08) { defDur = v.getUint32(p); p += 4; }
    let defSize = trex.size || 0;
    if (tf & 0x10) { defSize = v.getUint32(p); p += 4; }
    let defFlags = trex.flags || 0;
    if (tf & 0x20) { defFlags = v.getUint32(p); p += 4; }
    if (tf & 0x10000) continue; // duration-is-empty
    if (baseOffset == null) {
      baseOffset = tf & 0x20000 ? moofAbs : prevTrafDataEnd ?? moofAbs;
    }
    let dts = null;
    const tfdt = child(u8, traf, 'tfdt');
    if (tfdt) {
      const q = tfdt.start + tfdt.header;
      dts = u8[q] === 1 ? v.getUint32(q + 4) * 2 ** 32 + v.getUint32(q + 8) : v.getUint32(q + 4);
    }
    let dataCursor = baseOffset;
    let firstRun = true;
    for (const trun of iterBoxes(u8, ...inner(traf))) {
      if (trun.type !== 'trun') continue;
      let q = trun.start + trun.header;
      const version = u8[q];
      const fl = v.getUint32(q) & 0xffffff;
      q += 4;
      const count = v.getUint32(q);
      q += 4;
      let offset = dataCursor;
      if (fl & 0x01) { offset = baseOffset + v.getInt32(q); q += 4; }
      let firstFlags = null;
      if (fl & 0x04) { firstFlags = v.getUint32(q); q += 4; }
      const durs = new Uint32Array(count);
      const sizes = new Uint32Array(count);
      const flags = new Uint32Array(count);
      const ctos = new Int32Array(count);
      let total = 0;
      for (let i = 0; i < count; i++) {
        let d = defDur;
        let s = defSize;
        let f = i === 0 && firstFlags != null ? firstFlags : defFlags;
        let c = 0;
        if (fl & 0x100) { d = v.getUint32(q); q += 4; }
        if (fl & 0x200) { s = v.getUint32(q); q += 4; }
        if (fl & 0x400) { f = v.getUint32(q); q += 4; }
        if (fl & 0x800) { c = version === 0 ? v.getUint32(q) : v.getInt32(q); q += 4; }
        durs[i] = d;
        sizes[i] = s;
        flags[i] = f;
        ctos[i] = c;
        total += s;
      }
      runs.push({ trackId, dts: firstRun ? dts : null, sdi, offset, size: total, count, durs, sizes, flags, ctos });
      dataCursor = offset + total;
      firstRun = false;
    }
    prevTrafDataEnd = dataCursor;
  }
  return runs;
}

class TrackTable {
  constructor(info, index) {
    this.info = info;
    this.index = index;
    this.count = 0;
    this.cap = 0;
    this.dur = new Uint32Array(0);
    this.size = new Uint32Array(0);
    this.cto = new Int32Array(0);
    this.sync = new Uint8Array(0);
    this.runs = [];
    this.firstDts = null;
    this.nextDts = 0;
    this.allSync = true;
    this.hasCto = false;
    this.minCto = 0;
    this.bytes = 0;
  }

  ensure(n) {
    if (n <= this.cap) return;
    let cap = Math.max(1024, this.cap * 2);
    while (cap < n) cap *= 2;
    const grow = (arr, Ctor) => {
      const a = new Ctor(cap);
      a.set(arr.subarray(0, this.count));
      return a;
    };
    this.dur = grow(this.dur, Uint32Array);
    this.size = grow(this.size, Uint32Array);
    this.cto = grow(this.cto, Int32Array);
    this.sync = grow(this.sync, Uint8Array);
    this.cap = cap;
  }

  addRun(run, src) {
    if (!run.count) return;
    if (this.firstDts === null) {
      this.firstDts = run.dts ?? 0;
      this.nextDts = this.firstDts;
    } else if (run.dts != null && this.count > 0) {
      const gap = run.dts - this.nextDts;
      // Stretch the previous sample over a gap to keep audio and video in sync; ignore overlaps
      if (gap > 0 && gap < this.info.timescale * 600) {
        this.dur[this.count - 1] += gap;
        this.nextDts += gap;
      }
    }
    const startDts = this.nextDts;
    const first = this.count;
    this.ensure(this.count + run.count);
    for (let i = 0; i < run.count; i++) {
      const k = this.count++;
      this.dur[k] = run.durs[i];
      this.size[k] = run.sizes[i];
      this.cto[k] = run.ctos[i];
      const sync = (run.flags[i] & 0x00010000) === 0;
      this.sync[k] = sync ? 1 : 0;
      if (!sync) this.allSync = false;
      if (run.ctos[i] !== 0) this.hasCto = true;
      if (run.ctos[i] < this.minCto) this.minCto = run.ctos[i];
      this.nextDts += run.durs[i];
    }
    this.bytes += run.size;
    this.runs.push({ src, offset: run.offset, size: run.size, first, count: run.count, sdi: run.sdi || 1, t: startDts / this.info.timescale });
  }
}

/** Remuxes samples into a standard MP4. */
export class Mp4Muxer {
  constructor() {
    this.tracks = [];
    this.sources = [];
  }

  addSource(blob = null) {
    this.sources.push(blob);
    return this.sources.length - 1;
  }

  setSource(index, blob) {
    this.sources[index] = blob;
  }

  /**
   * Registers an input (one initialization segment). Returns a handle that later fragments use to find their tracks.
   * @param opts.only keep only 'vide' or 'soun'
   */
  addInput(initBytes, opts = {}) {
    const input = { map: new Map(), trex: new Map(), only: opts.only || null, init: null };
    this.extendInput(input, initBytes);
    return input;
  }

  /** Regular (non-fragmented) MP4: add it straight from its sample tables */
  addProgressive(input, srcIndex) {
    for (const tr of input.init.tracks) {
      const t = input.map.get(tr.trackId);
      if (!t) continue;
      for (const run of progressiveRuns(tr)) t.addRun(run, srcIndex);
    }
  }

  /** mux.js emits an init with every output; add any new track (e.g. audio that shows up late). */
  extendInput(input, initBytes) {
    const init = parseInit(initBytes);
    if (!input.init) input.init = init;
    if (init.tracks.some((t) => t.encrypted) || init.hasPssh) {
      throw new Mp4Error(i18n('drmMediaNote'));
    }
    for (const tr of init.tracks) {
      if (tr.trex) input.trex.set(tr.trackId, tr.trex);
      const known = input.map.get(tr.trackId);
      if (known) {
        // The codec settings of a track changed partway (e.g. an ad with another resolution or sample rate): they can't share one MP4 track
        if (known.info.timescale !== tr.timescale || !sameBytes(known.info.raw.stsd, tr.raw.stsd)) {
          throw new Mp4Error(i18n('errCodecChanged'));
        }
        continue;
      }
      if (tr.handler !== 'vide' && tr.handler !== 'soun') continue;
      if (input.only && tr.handler !== input.only) continue;
      const t = new TrackTable(tr, this.tracks.length);
      this.tracks.push(t);
      input.map.set(tr.trackId, t);
    }
    return input;
  }

  /** Parses data in memory (may contain several moof+mdat) that lives at absBase in source srcIndex. */
  addFragments(input, u8, srcIndex, absBase = 0) {
    for (const b of iterBoxes(u8, 0, u8.length)) {
      if (b.type === 'moof') this._addMoof(input, u8, b, srcIndex, absBase);
    }
  }

  _addMoof(input, u8, moof, srcIndex, absBase) {
    const runs = parseMoof(u8, moof, absBase, (id) => input.trex.get(id));
    for (const r of runs) {
      const t = input.map.get(r.trackId);
      if (t) t.addRun(r, srcIndex);
    }
  }

  /** Streams through a large fMP4 file (e.g. a DASH audio/video track), reading only the moof boxes, not the media data. */
  async addFragmentsFromBlob(input, blob, srcIndex, signal) {
    let off = 0;
    const size = blob.size;
    while (off + 8 <= size) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const head = new Uint8Array(await blob.slice(off, Math.min(size, off + 16)).arrayBuffer());
      const h = readBoxHeader(head, 0, head.length);
      if (!h) break;
      let boxSize = h.size;
      if (dv(head).getUint32(0) === 0) boxSize = size - off;
      if (h.type === 'moof') {
        const moofBytes = new Uint8Array(await blob.slice(off, off + boxSize).arrayBuffer());
        const mh = readBoxHeader(moofBytes, 0, moofBytes.length);
        this._addMoof(input, moofBytes, mh, srcIndex, off);
      }
      off += boxSize;
    }
  }

  get trackCount() {
    return this.tracks.filter((t) => t.count > 0).length;
  }

  summary() {
    return this.tracks
      .filter((t) => t.count)
      .map((t) => ({
        type: t.info.handler === 'vide' ? 'video' : 'audio',
        codec: t.info.codec,
        samples: t.count,
        duration: sumDur(t) / t.info.timescale,
        width: t.info.width,
        height: t.info.height,
      }));
  }

  /** Builds the final MP4 and returns { blob, duration }. */
  build(type = 'video/mp4') {
    const tracks = this.tracks.filter((t) => t.count > 0);
    if (!tracks.length) throw new Mp4Error(i18n('errNoMediaData'));
    for (const t of tracks) if (this.sources[t.runs[0].src] == null) throw new Mp4Error(i18n('errSourceMissing'));
    const MOVIE_TS = 1000;

    for (const t of tracks) {
      const ts = t.info.timescale;
      t.ctoShift = t.minCto < 0 ? -t.minCto : 0;
      t.mediaDuration = sumDur(t);
      // Media time of the first sample to present: from the edit list if there is one (e.g. AAC encoder delay), otherwise the first composition time
      const E = t.info.elstMediaTime;
      const sourceM = E != null ? Math.max(t.firstDts, E) : t.firstDts + t.cto[0];
      t.mediaTime = sourceM - t.firstDts + t.ctoShift;
      t.srcStart = (sourceM - (E ?? 0)) / ts;
      t.trimmed = Math.max(0, t.mediaTime - (t.cto[0] + t.ctoShift));
    }
    const t0 = Math.min(...tracks.map((t) => t.srcStart));
    let movieDuration = 0;
    for (const t of tracks) {
      const ts = t.info.timescale;
      const delay = Math.round((t.srcStart - t0) * MOVIE_TS);
      // The composition range is [cto0, total duration + cto0); the part skipped by the edit list doesn't count
      const present = Math.max(0, Math.round(((t.mediaDuration - t.trimmed) / ts) * MOVIE_TS));
      t.edits = [];
      if (delay > 0) t.edits.push({ dur: delay, mediaTime: -1 });
      if (delay > 0 || t.mediaTime > 0) t.edits.push({ dur: present, mediaTime: t.mediaTime });
      t.tkhdDuration = t.edits.length ? t.edits.reduce((a, e) => a + e.dur, 0) : Math.round((t.mediaDuration / ts) * MOVIE_TS);
      movieDuration = Math.max(movieDuration, t.tkhdDuration);
    }

    // Interleave chunks in time order so playback reads the disk more sequentially
    const chunks = [];
    for (const t of tracks) for (const r of t.runs) chunks.push({ t, r });
    chunks.sort((a, b) => a.r.t - b.r.t || a.t.index - b.t.index);
    let payload = 0;
    for (const c of chunks) {
      c.r.pos = payload;
      payload += c.r.size;
    }

    const ftyp = makeFtyp(tracks);
    const mdatHeaderSize = payload + 8 > 0xffffffff ? 16 : 8;
    const writeMoov = (base, co64) => {
      const w = new Writer(64 * 1024);
      const mv = w.begin('moov');
      writeMvhd(w, MOVIE_TS, movieDuration, tracks.length + 1);
      tracks.forEach((t, i) => writeTrak(w, t, i + 1, base, co64));
      w.end(mv);
      return w.bytes();
    };
    let useCo64 = false;
    let probe = writeMoov(0, false);
    if (ftyp.length + probe.length + mdatHeaderSize + payload > 0xffffffff) {
      useCo64 = true;
      probe = writeMoov(0, true);
    }
    const base = ftyp.length + probe.length + mdatHeaderSize;
    const moov = writeMoov(base, useCo64);
    if (moov.length !== probe.length) throw new Mp4Error(i18n('errMoovSize'));

    const mdatHeader = new Uint8Array(mdatHeaderSize);
    const hv = dv(mdatHeader);
    if (mdatHeaderSize === 16) {
      hv.setUint32(0, 1);
      mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
      const total = payload + 16;
      hv.setUint32(8, Math.floor(total / 2 ** 32));
      hv.setUint32(12, total >>> 0);
    } else {
      hv.setUint32(0, payload + 8);
      mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
    }
    const parts = [ftyp, moov, mdatHeader];
    // Merge adjacent slices from the same source to keep the number of Blob parts small
    let cur = null;
    for (const c of chunks) {
      if (cur && cur.src === c.r.src && cur.end === c.r.offset) {
        cur.end += c.r.size;
      } else {
        if (cur) parts.push(this.sources[cur.src].slice(cur.start, cur.end));
        cur = { src: c.r.src, start: c.r.offset, end: c.r.offset + c.r.size };
      }
    }
    if (cur) parts.push(this.sources[cur.src].slice(cur.start, cur.end));
    const blob = new Blob(parts, { type });
    return { blob, duration: movieDuration / MOVIE_TS, size: blob.size };
  }
}

function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sumDur(t) {
  let s = 0;
  for (let i = 0; i < t.count; i++) s += t.dur[i];
  return s;
}

// ---------- Writing ----------

class Writer {
  constructor(cap = 1024) {
    this.buf = new Uint8Array(cap);
    this.v = dv(this.buf);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
    this.v = dv(b);
  }

  u8(x) { this.ensure(1); this.buf[this.len++] = x; }
  u16(x) { this.ensure(2); this.v.setUint16(this.len, x); this.len += 2; }
  u32(x) { this.ensure(4); this.v.setUint32(this.len, x >>> 0); this.len += 4; }
  i32(x) { this.ensure(4); this.v.setInt32(this.len, x); this.len += 4; }
  u64(x) { this.u32(Math.floor(x / 2 ** 32)); this.u32(x >>> 0); }
  i64(x) { this.ensure(8); this.v.setBigInt64(this.len, BigInt(x)); this.len += 8; }
  zeros(n) { this.ensure(n); this.buf.fill(0, this.len, this.len + n); this.len += n; }
  raw(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  str(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }

  begin(type) {
    const at = this.len;
    this.u32(0);
    this.str(type);
    return at;
  }

  full(type, version, flags) {
    const at = this.begin(type);
    this.u32((version << 24) | flags);
    return at;
  }

  end(at) {
    this.v.setUint32(at, this.len - at);
  }

  bytes() {
    return this.buf.slice(0, this.len);
  }
}

function makeFtyp(tracks) {
  const w = new Writer(64);
  const at = w.begin('ftyp');
  w.str('isom');
  w.u32(0x200);
  const brands = ['isom', 'iso2', 'mp41'];
  if (tracks.some((t) => /^avc/.test(t.info.codec))) brands.push('avc1');
  for (const b of brands) w.str(b);
  w.end(at);
  return w.bytes();
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function writeMvhd(w, timescale, duration, nextTrackId) {
  const v1 = duration > 0xffffffff;
  const at = w.full('mvhd', v1 ? 1 : 0, 0);
  if (v1) { w.u64(0); w.u64(0); w.u32(timescale); w.u64(duration); }
  else { w.u32(0); w.u32(0); w.u32(timescale); w.u32(duration); }
  w.u32(0x00010000); // rate
  w.u16(0x0100); // volume
  w.zeros(10);
  for (const m of MATRIX) w.u32(m);
  w.zeros(24);
  w.u32(nextTrackId);
  w.end(at);
}

function writeTrak(w, t, trackId, base, useCo64) {
  const info = t.info;
  const isAudio = info.handler === 'soun';
  const trak = w.begin('trak');

  const v1 = t.tkhdDuration > 0xffffffff;
  const tk = w.full('tkhd', v1 ? 1 : 0, 0x3);
  if (v1) { w.u64(0); w.u64(0); w.u32(trackId); w.u32(0); w.u64(t.tkhdDuration); }
  else { w.u32(0); w.u32(0); w.u32(trackId); w.u32(0); w.u32(t.tkhdDuration); }
  w.zeros(8);
  w.u16(0); // layer
  w.u16(isAudio ? 1 : 0); // alternate_group
  w.u16(isAudio ? 0x0100 : 0);
  w.u16(0);
  for (const m of MATRIX) w.u32(m);
  w.u32(isAudio ? 0 : Math.round(info.width * 65536));
  w.u32(isAudio ? 0 : Math.round(info.height * 65536));
  w.end(tk);

  if (t.edits.length) {
    const ed = w.begin('edts');
    const big = t.edits.some((e) => e.dur > 0xffffffff || e.mediaTime > 0x7fffffff);
    const el = w.full('elst', big ? 1 : 0, 0);
    w.u32(t.edits.length);
    for (const e of t.edits) {
      if (big) { w.u64(e.dur); w.i64(e.mediaTime); }
      else { w.u32(e.dur); w.i32(e.mediaTime); }
      w.u16(1);
      w.u16(0);
    }
    w.end(el);
    w.end(ed);
  }

  const mdia = w.begin('mdia');
  const mv1 = t.mediaDuration > 0xffffffff;
  const md = w.full('mdhd', mv1 ? 1 : 0, 0);
  if (mv1) { w.u64(0); w.u64(0); w.u32(info.timescale); w.u64(t.mediaDuration); }
  else { w.u32(0); w.u32(0); w.u32(info.timescale); w.u32(t.mediaDuration); }
  w.u16(info.language || 0x55c4); // 'und'
  w.u16(0);
  w.end(md);
  w.raw(info.raw.hdlr);

  const minf = w.begin('minf');
  if (info.raw.mhd) w.raw(info.raw.mhd);
  else if (isAudio) { const s = w.full('smhd', 0, 0); w.u32(0); w.end(s); }
  else { const s = w.full('vmhd', 0, 1); w.zeros(8); w.end(s); }
  if (info.raw.dinf) w.raw(info.raw.dinf);
  else {
    const di = w.begin('dinf');
    const dr = w.full('dref', 0, 0);
    w.u32(1);
    const u = w.full('url ', 0, 1);
    w.end(u);
    w.end(dr);
    w.end(di);
  }

  const stbl = w.begin('stbl');
  w.raw(info.raw.stsd);

  // stts
  {
    const at = w.full('stts', 0, 0);
    const cntAt = w.len;
    w.u32(0);
    let n = 0;
    let i = 0;
    while (i < t.count) {
      const d = t.dur[i];
      let j = i + 1;
      while (j < t.count && t.dur[j] === d) j++;
      w.u32(j - i);
      w.u32(d);
      n++;
      i = j;
    }
    w.v.setUint32(cntAt, n);
    w.end(at);
  }
  // ctts
  if (t.hasCto || t.ctoShift) {
    const at = w.full('ctts', 0, 0);
    const cntAt = w.len;
    w.u32(0);
    let n = 0;
    let i = 0;
    while (i < t.count) {
      const c = t.cto[i];
      let j = i + 1;
      while (j < t.count && t.cto[j] === c) j++;
      w.u32(j - i);
      w.u32(c + t.ctoShift);
      n++;
      i = j;
    }
    w.v.setUint32(cntAt, n);
    w.end(at);
  }
  // stss
  if (!t.allSync) {
    const at = w.full('stss', 0, 0);
    const cntAt = w.len;
    w.u32(0);
    let n = 0;
    for (let i = 0; i < t.count; i++) {
      if (t.sync[i]) { w.u32(i + 1); n++; }
    }
    w.v.setUint32(cntAt, n);
    w.end(at);
  }
  // stsc: each trun is one chunk
  {
    const at = w.full('stsc', 0, 0);
    const cntAt = w.len;
    w.u32(0);
    let n = 0;
    let prev = null;
    t.runs.forEach((r, idx) => {
      if (!prev || prev.count !== r.count || prev.sdi !== r.sdi) {
        w.u32(idx + 1);
        w.u32(r.count);
        w.u32(r.sdi);
        n++;
        prev = r;
      }
    });
    w.v.setUint32(cntAt, n);
    w.end(at);
  }
  // stsz
  {
    const at = w.full('stsz', 0, 0);
    let same = true;
    for (let i = 1; i < t.count; i++) if (t.size[i] !== t.size[0]) { same = false; break; }
    if (same) { w.u32(t.size[0]); w.u32(t.count); }
    else {
      w.u32(0);
      w.u32(t.count);
      w.ensure(t.count * 4);
      for (let i = 0; i < t.count; i++) { w.v.setUint32(w.len, t.size[i]); w.len += 4; }
    }
    w.end(at);
  }
  // stco / co64
  {
    const at = w.full(useCo64 ? 'co64' : 'stco', 0, 0);
    w.u32(t.runs.length);
    for (const r of t.runs) {
      const off = base + (r.pos || 0);
      if (useCo64) w.u64(off);
      else w.u32(off);
    }
    w.end(at);
  }
  w.end(stbl);
  w.end(minf);
  w.end(mdia);
  w.end(trak);
}

// ---------- Probing ----------

/** Reads the ftyp/moov at the start of a Blob (to tell what a DASH track contains). */
export async function readInitFromBlob(blob) {
  let off = 0;
  for (let guard = 0; off + 8 <= blob.size && guard < 100000; guard++) {
    const head = new Uint8Array(await blob.slice(off, off + 16).arrayBuffer());
    const h = readBoxHeader(head, 0, head.length);
    if (!h) break;
    const size = dv(head).getUint32(0) === 0 ? blob.size - off : h.size;
    if (h.type === 'moov') return new Uint8Array(await blob.slice(off, off + size).arrayBuffer());
    if (h.type === 'moof') break; // fragments have started; moov only comes before them
    off += size;
  }
  throw new Mp4Error(i18n('errNoMoovFile'));
}

/** Identifies the track from the first bytes of a file (e.g. 64 KB); returns null if the data is incomplete. */
export function probeInitBytes(u8) {
  try {
    for (const b of iterBoxes(u8, 0, u8.length)) {
      if (b.type === 'moov') {
        if (b.end > u8.length) return null;
        const init = parseInit(u8.subarray(b.start, b.end));
        const av = init.tracks.filter((x) => x.handler === 'vide' || x.handler === 'soun');
        if (!av.length) return null;
        const t = av.find((x) => x.handler === 'vide') || av[0];
        return {
          // Only single-track files (video only or audio only) need to be merged with another track
          track: av.length === 1 ? (t.handler === 'vide' ? 'video' : 'audio') : null,
          tracks: av.length,
          codec: t.codec,
          width: t.width,
          height: t.height,
          encrypted: av.some((x) => x.encrypted) || init.hasPssh,
          fragmented: init.fragmented,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}
