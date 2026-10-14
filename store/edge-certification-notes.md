# Notes for certification (Microsoft Edge Add-ons)

Paste this into **Notes for certification** when submitting to Edge Add-ons. No account or sign-in is needed.

```
Shuttle DM is a download manager. Everything runs locally; it has no account, no server and no remote code.

How to test:
1. Click the toolbar icon, then "New download". Paste this address and click "Start download":
   https://proof.ovh.net/files/100Mb.dat
   Open the download manager (toolbar icon > "Manager") to see the file downloading over several connections. Pause and resume it.
2. Video stream: in "New download", paste
   https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
   It is saved as an MP4 file (the stream is converted without re-encoding).
3. Video on a page: open https://www.w3schools.com/html/html5_video.asp and play the video.
   Hover over it and click "Download video", or click the toolbar icon to see it under "On this page".
4. Right-click any link and choose "Download link with Shuttle DM". Right-click a page and choose "Download all links and resources on this page…".
5. Toolbar icon > "Save page" saves the current page as an MHTML file.

Notes:
- With "Take over browser downloads" on (default), ordinary downloads of archives, installers, documents and videos are handed to the extension.
- The extension does not download videos from YouTube and cannot download DRM-protected media.
- The interface follows the browser language: English, Chinese (Simplified), French, Japanese, Korean.
```
