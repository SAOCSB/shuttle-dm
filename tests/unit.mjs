// Unit tests for pure functions: M3U8 parsing, file names, Content-Disposition, media detection, translations.
// Run: node --test unit.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initI18n, LOCALES } from '../extension/common/i18n.js';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const readLocale = (loc) => JSON.parse(fs.readFileSync(path.join(EXT, '_locales', loc, 'messages.json'), 'utf8'));
await initI18n('en', readLocale);
import { parseM3U8, encryptionOf, ivFor, parseAttributes } from '../extension/common/m3u8.js';
import {
  parseContentDisposition, sanitizeFilename, sanitizeSubpath, ensureExt, extOf, categoryOf, parseContentRange, fixMojibake, qualityLabel,
} from '../extension/common/util.js';
import { classifyResponse, mediaKey } from '../extension/common/media.js';

test('M3U8: master playlist with alternate audio', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="audio/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90",AUDIO="aud"
https://cdn.example.com/hi/index.m3u8
`;
  const pl = parseM3U8(text, 'https://example.com/v/master.m3u8');
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].height, 1080, 'sorted best first');
  assert.equal(pl.variants[0].uri, 'https://cdn.example.com/hi/index.m3u8');
  assert.equal(pl.variants[1].uri, 'https://example.com/v/low/index.m3u8');
  assert.equal(pl.variants[1].codecs, 'avc1.4d401e,mp4a.40.2');
  assert.equal(pl.media[0].uri, 'https://example.com/v/audio/zh.m3u8');
  assert.equal(pl.media[0].default, true);
  assert.equal(qualityLabel(pl.variants[0]), '1080p (5.0 Mbps)');
});

test('M3U8: media playlist with keys, byte ranges, map and discontinuity', () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
media.mp4
#EXTINF:5.5,
#EXT-X-BYTERANGE:2000
media.mp4
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,title
other.mp4
#EXT-X-ENDLIST
`;
  const pl = parseM3U8(text, 'https://e.com/a/b.m3u8');
  assert.equal(pl.type, 'media');
  assert.equal(pl.segments.length, 3);
  assert.deepEqual(pl.segments.map((s) => s.seq), [100, 101, 102]);
  assert.deepEqual(pl.segments[0].byterange, { offset: 720, length: 1000 });
  assert.deepEqual(pl.segments[1].byterange, { offset: 1720, length: 2000 }, 'offset continues from previous range');
  assert.equal(pl.segments[0].key, 0);
  assert.equal(pl.segments[2].key, -1, 'METHOD=NONE clears the key');
  assert.equal(pl.segments[2].discontinuity, true);
  assert.equal(pl.maps[0].uri, 'https://e.com/a/init.mp4');
  assert.equal(pl.duration, 15.5);
  assert.equal(pl.endList, true);
  assert.equal(encryptionOf(pl), 'aes-128');
});

test('M3U8: DRM detection and IV derivation', () => {
  const drm = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n', 'https://e.com/');
  assert.equal(encryptionOf(drm), 'drm');
  assert.deepEqual([...ivFor({ iv: null }, 258)], [...new Array(14).fill(0), 1, 2]);
  assert.equal(ivFor({ iv: '0x000102030405060708090A0B0C0D0E0F' }, 0)[15], 15);
  assert.deepEqual(parseAttributes('A=1,B="x,y",C=0xFF'), { A: '1', B: 'x,y', C: '0xFF' });
  assert.throws(() => parseM3U8('<html>', 'https://e.com/'), (e) => e.code === 'NOT_M3U8' && /M3U8/.test(e.message));
});

test('Content-Disposition and filename handling', () => {
  assert.equal(parseContentDisposition(`attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.zip`), '测试.zip');
  assert.equal(parseContentDisposition('attachment; filename="report final.pdf"'), 'report final.pdf');
  assert.equal(parseContentDisposition('inline; filename=data.csv'), 'data.csv');
  // raw UTF-8 bytes that were read as Latin-1
  const raw = Buffer.from('年度报告.pdf', 'utf8').toString('latin1');
  assert.equal(parseContentDisposition(`attachment; filename="${raw}"`), '年度报告.pdf');
  assert.equal(fixMojibake('plain.txt'), 'plain.txt');
  assert.equal(sanitizeFilename('a/b:c*?"<>|.txt'), 'a_b_c______.txt');
  assert.equal(sanitizeFilename('  ..hidden.  '), 'hidden');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename(''), 'download');
  assert.equal(sanitizeSubpath('../视频//合集/./a'), '视频/合集/a');
  assert.equal(ensureExt('video', 'video/mp4'), 'video.mp4');
  assert.equal(ensureExt('download.php', 'application/pdf'), 'download.pdf');
  assert.equal(ensureExt('notes.txt', 'text/html'), 'notes.txt');
  assert.equal(extOf('https://e.com/a/b.TAR.GZ?x=1'), 'gz');
  assert.equal(categoryOf('a.mkv'), 'video');
  assert.equal(categoryOf('noext', 'application/zip'), 'archive');
  assert.deepEqual(parseContentRange('bytes 100-199/1000'), { start: 100, end: 199, total: 1000 });
  assert.deepEqual(parseContentRange('bytes 0-9/*'), { start: 0, end: 9, total: null });
});

test('media sniffing rules', () => {
  const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const c = (url, statusCode, h) => classifyResponse({ url, statusCode, responseHeaders: H(h) }, 200 * 1024);
  assert.equal(c('https://x.com/v/index.m3u8', 200, { 'content-type': 'application/vnd.apple.mpegurl' }).kind, 'hls');
  assert.equal(c('https://x.com/play?type=m3u8', 200, { 'content-type': 'text/plain' }).guessed, true);
  assert.equal(c('https://x.com/a.mp4', 206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99/50000000' }).size, 50000000);
  assert.equal(c('https://x.com/seg1.ts', 200, { 'content-type': 'video/mp2t', 'content-length': '900000' }), null, 'HLS segments are not listed');
  assert.equal(c('https://x.com/v.m4s', 206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/30000000' }).kind, 'track');
  assert.equal(c('https://x.com/ding.mp3', 200, { 'content-type': 'audio/mpeg', 'content-length': '9000' }), null, 'tiny sounds ignored');
  assert.equal(c('https://x.com/page', 200, { 'content-type': 'text/html' }), null);
  assert.equal(c('https://x.com/missing.mp4', 404, { 'content-type': 'video/mp4' }), null);
  assert.equal(mediaKey('https://x.com/a.mp4?range=0-100&id=1'), 'https://x.com/a.mp4?id=1');
});

test('sites without video download support are recognised', async () => {
  const { isVideoBlockedUrl } = await import('../extension/common/sites.js');
  for (const u of [
    'https://www.youtube.com/watch?v=x', 'https://m.youtube.com/', 'https://music.youtube.com/', 'https://youtu.be/abc',
    'https://www.youtube-nocookie.com/embed/x', 'https://rr3---sn-abc.googlevideo.com/videoplayback?x=1', 'https://YOUTUBE.COM./',
  ]) assert.ok(isVideoBlockedUrl(u), u);
  for (const u of ['https://example.com/video.mp4', 'https://notyoutube.com/', 'https://youtube.com.example.org/', '', 'not a url', null]) {
    assert.ok(!isVideoBlockedUrl(u), String(u));
  }
});

test('page titles used as file names drop the site name', async () => {
  const { cleanTitle } = await import('../extension/background/media-view.js');
  assert.equal(cleanTitle('My Trip - Example Video', 'https://www.example.com/v/1'), 'My Trip');
  assert.equal(cleanTitle('My Trip | EXAMPLE', 'https://example.com/'), 'My Trip');
  assert.equal(cleanTitle('旅行记录_某某视频网', 'https://v.test.cn/x'), '旅行记录');
  assert.equal(cleanTitle('第 1 集 - 第 2 集', 'https://example.org/'), '第 1 集 - 第 2 集');
  assert.equal(cleanTitle('Spider-Man trailer', 'https://example.org/'), 'Spider-Man trailer');
  assert.equal(cleanTitle('Example', 'https://example.org/'), 'Example');
  assert.equal(cleanTitle('', ''), '');
});

test('translations: every locale has every message with the same substitutions', () => {
  const en = readLocale('en');
  for (const loc of LOCALES) {
    const msgs = readLocale(loc);
    assert.deepEqual(Object.keys(msgs).sort(), Object.keys(en).sort(), `keys differ in ${loc}`);
    for (const [key, { message }] of Object.entries(msgs)) {
      const subs = (s) => [...new Set(s.match(/\$[1-9]/g) || [])].sort().join();
      assert.equal(subs(message), subs(en[key].message), `${loc}/${key} substitutions`);
      // chrome.i18n treats $name$ as a named placeholder; an undefined one breaks loading the extension
      assert.ok(!/\$[A-Za-z0-9_]+\$/.test(message), `${loc}/${key} contains a $…$ sequence`);
      assert.ok(message.trim(), `${loc}/${key} is empty`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) assert.ok(en[m[1]], `manifest uses missing ${m[1]}`);
  for (const loc of LOCALES) {
    const msgs = readLocale(loc);
    assert.ok([...msgs.extDescription.message].length <= 132, `${loc} description is longer than 132 characters`);
    assert.ok([...msgs.extName.message].length <= 75, `${loc} name is longer than 75 characters`);
  }
});

test('translations: every message key used in the source exists', () => {
  const en = readLocale('en');
  const used = new Set();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!['vendor', '_locales', 'fonts'].includes(ent.name)) walk(p); continue; }
      if (!/\.(js|html)$/.test(ent.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\b(?:t|tr|i18n)\(\s*'(\w+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/\b(?:tp|pluralKey)\(\s*'(\w+)'/g)) { used.add(m[1] + '_one'); used.add(m[1] + '_other'); }
      for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="(\w+)"/g)) used.add(m[1]);
      for (const m of src.matchAll(/withIcon\([^,]+,\s*[^,]+,\s*'(\w+)'\)/g)) used.add(m[1]);
      // t(cond ? 'keyA' : 'keyB'): every quoted word that is not compared against
      for (const call of src.matchAll(/\b(?:t|tr|i18n)\(([^()]*\?[^()]*)\)/g)) {
        for (const m of call[1].matchAll(/(===\s*|!==\s*)?'(\w+)'/g)) if (!m[1]) used.add(m[2]);
      }
    }
  };
  walk(EXT);
  const missing = [...used].filter((k) => !en[k]);
  assert.deepEqual(missing, []);
  assert.ok(used.size > 300, `only ${used.size} keys found; is the scan broken?`);
});

test('formatting follows the UI language', async () => {
  const { formatBytes, formatEta, formatSpeed } = await import('../extension/common/util.js');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatSpeed(4.5 * 1024 * 1024), '4.5 MB/s');
  assert.equal(formatEta(125), '2 min 5 s');
  await initI18n('fr-FR', readLocale);
  assert.equal(formatBytes(1536), '1,5 Ko');
  assert.equal(formatEta(3700), '1 h 2 min');
  await initI18n('ja', readLocale);
  assert.equal(formatEta(59), '59 秒');
  await initI18n('zh-TW', readLocale); // not translated: falls back to English like Chrome does
  assert.equal(formatEta(59), '59 s');
  await initI18n('en', readLocale);
});
