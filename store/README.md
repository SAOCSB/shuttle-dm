# Store assets

Everything needed to publish Shuttle DM on the Chrome Web Store and Microsoft Edge Add-ons.

| File | Use |
| --- | --- |
| [`PUBLISHING.zh-CN.md`](PUBLISHING.zh-CN.md) | Step-by-step publishing guide (Chinese) |
| [`listing/`](listing) | Store descriptions in English (default), 简体中文, Français, 日本語 and 한국어 |
| [`privacy-practices.md`](privacy-practices.md) | Answers for the Chrome Web Store *Privacy practices* tab: single purpose, permission justifications, data usage |
| [`edge-certification-notes.md`](edge-certification-notes.md) | Test instructions for Edge certification |
| `images/icon-128.png` | Store icon (128×128, 96×96 artwork with transparent padding) |
| `images/edge-logo-300.png` | Edge Add-ons logo (300×300) |
| `images/screenshots/<language>/` | Five 1280×800 screenshots per language |
| `images/promo/small-440x280-<language>.png` | Small promotional tile |
| `images/promo/marquee-1400x560-<language>.png` | Marquee / large promotional tile |

The package itself is built with `bash scripts/build-zip.sh` (creates `dist/shuttle-dm-<version>.zip`).
The screenshots were taken from the real extension on fictional demo pages with original, generated artwork.
