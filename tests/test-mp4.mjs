// Node-side tests for the MP4 pipeline: TS->MP4 (mux.js), fMP4 HLS->MP4, DASH A+V merge.
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Mp4Muxer, readInitFromBlob } from '../extension/common/mp4.js';
import { transmuxTs, probeTs } from '../extension/common/ts.js';
import { parseM3U8 } from '../extension/common/m3u8.js';
import { initI18n } from '../extension/common/i18n.js';
// Before running: npm install && bash make-assets.sh

const require = createRequire(import.meta.url);
await initI18n('en', async (loc) => JSON.parse(await fs.readFile(new URL(`../extension/_locales/${loc}/messages.json`, import.meta.url), 'utf8')));
const muxjs = require('mux.js');
const A = new URL('./assets/', import.meta.url).pathname;
const OUT = new URL('./.work/mp4-out/', import.meta.url).pathname;
await fs.mkdir(OUT, { recursive: true });

function ffprobe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames,duration,start_time:format=duration,format_name', '-of', 'json', file]).toString());
  return j;
}
function decodeErrors(file) {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return out.toString().trim();
  } catch (e) {
    return String(e.stderr || e.message);
  }
}
function report(name, file) {
  const p = ffprobe(file);
  const errs = decodeErrors(file);
  console.log(`\n== ${name}: ${file}`);
  console.log('format', p.format.format_name, 'duration', p.format.duration);
  for (const s of p.streams) console.log(' ', s.codec_type, s.codec_name, s.width || '', s.height || '', 'frames', s.nb_frames, 'dur', s.duration, 'start', s.start_time);
  console.log('decode errors:', errs ? errs.slice(0, 500) : 'none');
  return { p, errs };
}

async function tsToMp4(dir, prefix, outName) {
  const pl = parseM3U8(await fs.readFile(`${A}${dir}/${prefix}`, 'utf8'), `http://x/${dir}/${prefix}`);
  const files = pl.segments.map((s) => `${A}${dir}/${s.uri.split('/').pop()}`);
  const first = new Uint8Array(await fs.readFile(files[0]));
  console.log('probeTs', JSON.stringify(probeTs(first)));
  const muxer = new Mp4Muxer();
  const src = muxer.addSource(null);
  const chunks = [];
  let pos = 0;
  await transmuxTs({
    muxjs,
    readSegment: async (i) => new Uint8Array(await fs.readFile(files[i])),
    count: files.length,
    durations: pl.segments.map((s) => s.duration),
    append: async (u8) => { chunks.push(Buffer.from(u8)); const at = pos; pos += u8.length; return at; },
    muxer,
    srcIndex: src,
  });
  muxer.setSource(src, new Blob(chunks));
  console.log('summary', JSON.stringify(muxer.summary()));
  const { blob } = muxer.build();
  await fs.writeFile(OUT + outName, Buffer.from(await blob.arrayBuffer()));
  return report('TS->MP4 ' + dir, OUT + outName);
}

async function fmp4ToMp4() {
  const dir = `${A}hls/fmp4/`;
  const pl = parseM3U8(await fs.readFile(dir + 'index.m3u8', 'utf8'), 'http://x/hls/fmp4/index.m3u8');
  const muxer = new Mp4Muxer();
  const init = new Uint8Array(await fs.readFile(dir + 'init.mp4'));
  const input = muxer.addInput(init);
  for (const s of pl.segments) {
    const buf = new Uint8Array(await fs.readFile(dir + s.uri.split('/').pop()));
    const src = muxer.addSource(new Blob([buf]));
    muxer.addFragments(input, buf, src, 0);
  }
  console.log('summary', JSON.stringify(muxer.summary()));
  const { blob } = muxer.build();
  await fs.writeFile(OUT + 'fmp4.mp4', Buffer.from(await blob.arrayBuffer()));
  return report('fMP4 HLS->MP4', OUT + 'fmp4.mp4');
}

async function dashMerge() {
  const muxer = new Mp4Muxer();
  for (const f of ['video.m4s', 'audio.m4s']) {
    const blob = await openAsBlob(`${A}dash/${f}`);
    const init = await readInitFromBlob(blob);
    const input = muxer.addInput(init);
    const src = muxer.addSource(blob);
    await muxer.addFragmentsFromBlob(input, blob, src);
  }
  console.log('summary', JSON.stringify(muxer.summary()));
  const { blob } = muxer.build();
  await fs.writeFile(OUT + 'dash.mp4', Buffer.from(await blob.arrayBuffer()));
  return report('DASH merge', OUT + 'dash.mp4');
}

report('SOURCE', `${A}video.mp4`);
await tsToMp4('hls/ts', 'stream_720p.m3u8', 'ts720.mp4');
await tsToMp4('hls/ts', 'stream_360p.m3u8', 'ts360.mp4');
await fmp4ToMp4();
await dashMerge();
console.log('\nHEVC probe:', JSON.stringify(probeTs(new Uint8Array(await fs.readFile(`${A}hls/hevc/seg_000.ts`)))));
