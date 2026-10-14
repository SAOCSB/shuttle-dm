# Tests

A local test server (Range requests, throttling, dropped connections, Referer checks, HLS, live streams…) and end-to-end tests that load the extension into a real Chromium.

## Setup

You need Node.js 18+ and ffmpeg (with libx264, libx265 and aac).

```bash
cd tests
npm install          # puppeteer (downloads Chrome for Testing) and mux.js
npm run assets       # test videos, HLS streams, separate tracks and a 64 MB random file
```

> Branded Google Chrome 137+ no longer loads unpacked extensions from the command line, so the tests use the Chrome for Testing build that puppeteer downloads.
> Set `CHROME_PATH=/path/to/chromium` to use another Chromium.

## Running

```bash
npm run test:unit      # pure functions: M3U8 parsing, file names, Content-Disposition, detection rules, translations
npm run test:mp4       # MP4 muxer: TS→MP4, fMP4→MP4, merging separate tracks, checked with ffprobe/ffmpeg
npm run server         # in another terminal: test server at http://127.0.0.1:8080
npm run test:e2e       # end-to-end tests (opens a browser window, about 6 minutes)
node e2e.mjs hls       # only the tests whose name contains “hls”
npm run test:blocked   # video detection is off on YouTube but works elsewhere (no test server needed)
```

On Linux without a desktop, prefix the browser tests with `xvfb-run -a`.

The extension follows the browser's language. Run the browser tests in another language with `UI_LANG`, for example `UI_LANG=fr npm run test:e2e` (`en-US` by default; `zh-CN`, `fr`, `ja` and `ko` are translated).

Browser profiles and downloaded files go to `tests/.work/`, which can be deleted at any time.

## What the end-to-end tests cover

| Test | Checks |
| --- | --- |
| http: multi-connection + dynamic split | 64 MB file over several connections with dynamic splitting; SHA-256 matches |
| http: pause & resume | Resumes from where it paused (checks the Range start of the resumed request) |
| http: server without Range support | Single-connection download |
| http: flaky connections are retried | The server drops connections at random; the download reconnects and resumes |
| http: Referer rule (DNR) | A file that returns 403 without the right Referer |
| http: cookies are sent | A file that needs a cookie |
| hls: … | Several qualities, AES-128, fMP4, HEVC falling back to TS, Referer checks, pause & resume, live recording |
| dash / merge: … | Merging separate audio and video (fragmented and regular MP4), pause & resume |
| takeover: … | Taking over browser downloads, skipping small files, names that only come from Content-Disposition |
| hls: resolution change mid-stream | Falls back to TS instead of writing a broken MP4 when an inserted ad changes the resolution |
| page: … | Saving pages as MHTML and HTML |
| settings: … | Global speed limit (4 MB/s and 24 KB/s); slow connections are not mistaken for stalled ones |
| security | Content scripts in web pages can't call privileged commands or drive the download engine |
| takeover: resumes a paused duplicate | Downloading a paused link again resumes the existing task, so nothing is lost |
| update | After an update, the re-injected content script replaces the orphaned instance |
| persistence | Unfinished downloads continue after a browser restart |
| ui | Every page loads without script errors |
