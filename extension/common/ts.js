// MPEG-TS probing: reads PAT/PMT to tell whether the codecs can be remuxed into MP4 without re-encoding (mux.js handles H.264 + AAC).

import { i18n } from './i18n.js';

const STREAM_TYPES = {
  0x01: { kind: 'video', name: 'MPEG-1 Video' },
  0x02: { kind: 'video', name: 'MPEG-2 Video' },
  0x10: { kind: 'video', name: 'MPEG-4 Part 2' },
  0x1b: { kind: 'video', name: 'H.264', ok: true },
  0x24: { kind: 'video', name: 'HEVC' },
  0x42: { kind: 'video', name: 'AVS' },
  0xd2: { kind: 'video', name: 'AVS2' },
  0xea: { kind: 'video', name: 'VC-1' },
  0x03: { kind: 'audio', name: 'MP3' },
  0x04: { kind: 'audio', name: 'MP3' },
  0x0f: { kind: 'audio', name: 'AAC', ok: true },
  0x11: { kind: 'audio', name: 'AAC-LATM' },
  0x81: { kind: 'audio', name: 'AC-3' },
  0x87: { kind: 'audio', name: 'E-AC-3' },
  0x15: { kind: 'meta', name: 'ID3', ok: true },
};

function findSync(u8) {
  for (let i = 0; i < Math.min(u8.length - 376, 188 * 4); i++) {
    if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) return i;
  }
  return u8[0] === 0x47 ? 0 : -1;
}

/** Returns { isTs, streams:[{type,kind,name,ok}], hasVideo, hasAudio, convertible, reason } */
export function probeTs(u8) {
  const start = findSync(u8);
  if (start < 0) return { isTs: false, streams: [], convertible: false, reason: i18n('reasonNotTs') };
  let pmtPid = -1;
  let streams = null;
  for (let p = start; p + 188 <= u8.length && !streams; p += 188) {
    if (u8[p] !== 0x47) continue;
    const pusi = (u8[p + 1] & 0x40) !== 0;
    const pid = ((u8[p + 1] & 0x1f) << 8) | u8[p + 2];
    const afc = (u8[p + 3] >> 4) & 3;
    let off = p + 4;
    if (afc & 2) off += 1 + u8[off];
    if (!(afc & 1) || !pusi || off >= p + 188) continue;
    if (pid !== 0 && pid !== pmtPid) continue;
    off += 1 + u8[off]; // pointer_field
    const tableId = u8[off];
    const sectionLength = ((u8[off + 1] & 0x0f) << 8) | u8[off + 2];
    const end = Math.min(off + 3 + sectionLength - 4, p + 188);
    if (pid === 0 && tableId === 0x00) {
      for (let q = off + 8; q + 4 <= end; q += 4) {
        const program = (u8[q] << 8) | u8[q + 1];
        if (program !== 0) { pmtPid = ((u8[q + 2] & 0x1f) << 8) | u8[q + 3]; break; }
      }
    } else if (pid === pmtPid && tableId === 0x02) {
      const infoLen = ((u8[off + 10] & 0x0f) << 8) | u8[off + 11];
      streams = [];
      for (let q = off + 12 + infoLen; q + 5 <= end;) {
        const type = u8[q];
        const esLen = ((u8[q + 3] & 0x0f) << 8) | u8[q + 4];
        let info = STREAM_TYPES[type];
        if (type === 0x06) {
          // Private stream: AC-3/E-AC-3/DTS are recognised by their descriptors; anything else is subtitles/metadata
          let d = q + 5;
          info = { kind: 'meta', name: 'private data', ok: true };
          while (d + 2 <= q + 5 + esLen) {
            const tag = u8[d];
            if (tag === 0x6a) info = { kind: 'audio', name: 'AC-3' };
            else if (tag === 0x7a) info = { kind: 'audio', name: 'E-AC-3' };
            else if (tag === 0x7b) info = { kind: 'audio', name: 'DTS' };
            d += 2 + u8[d + 1];
          }
        }
        streams.push({ type, ...(info || { kind: 'other', name: `0x${type.toString(16)}`, ok: true }) });
        q += 5 + esLen;
      }
    }
  }
  if (!streams) return { isTs: true, streams: [], convertible: false, reason: i18n('reasonNoPmt') };
  const av = streams.filter((s) => s.kind === 'video' || s.kind === 'audio');
  const bad = av.filter((s) => !s.ok);
  return {
    isTs: true,
    streams,
    hasVideo: av.some((s) => s.kind === 'video'),
    hasAudio: av.some((s) => s.kind === 'audio'),
    convertible: av.length > 0 && bad.length === 0,
    reason: bad.length ? i18n('reasonEncodedAs', [...new Set(bad.map((s) => s.name))].join('/')) : '',
  };
}

/** Whether the data looks like ADTS/ID3-packed AAC (audio-only HLS segments) */
export function looksLikePackedAudio(u8) {
  if (u8.length < 4) return false;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return true; // ID3
  return u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0; // ADTS
}

/**
 * Converts a list of TS segments into fMP4 with mux.js and feeds them to an Mp4Muxer.
 * @param muxjs   the mux.js global
 * @param readSegment  async (i) => Uint8Array  reads one segment
 * @param count   number of segments
 * @param append  async (u8) => absOffset  writes converted fMP4 data to a temporary file and returns its offset
 * @param muxer   Mp4Muxer
 * @param srcIndex source index of the temporary file in the muxer
 */
export async function transmuxTs({ muxjs, readSegment, count, durations = [], discontinuities = [], append, muxer, srcIndex, onProgress, signal }) {
  const tm = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let input = null;
  let pending = [];
  let elapsed = 0;
  tm.on('data', (seg) => pending.push(seg));
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const data = await readSegment(i);
    if (discontinuities[i] && i > 0) {
      // Discontinuity (inserted ad, source switch): timestamps may jump, so continue from the duration so far
      tm.setBaseMediaDecodeTime(Math.round(elapsed * 90000));
    }
    elapsed += durations[i] || 0;
    tm.push(data);
    tm.flush();
    for (const seg of pending) {
      if (!seg.data || !seg.data.byteLength) continue;
      if (!input) input = muxer.addInput(seg.initSegment);
      else muxer.extendInput(input, seg.initSegment);
      const at = await append(seg.data);
      muxer.addFragments(input, seg.data, srcIndex, at);
    }
    pending = [];
    onProgress?.(i + 1, count);
  }
  return input;
}
