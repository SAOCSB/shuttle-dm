# Chrome Web Store: Privacy practices tab

Copy these answers into the **Privacy practices** tab of the Chrome Web Store Developer Dashboard. The Edge Add-ons dashboard asks a subset of the same questions.

## Single purpose

> Shuttle DM is a download manager. It downloads the files, web videos and web pages that the user chooses, using multiple connections with pause and resume, and keeps them in a download list.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `downloads` | Saves finished downloads to the user's downloads folder, shows them in the folder, and (when the user enables it) takes over browser downloads so they can be downloaded with multiple connections. |
| `downloads.open` | Lets the user open a finished download from the download manager (double-click or the "Open file" button). |
| `offscreen` | Runs the download engine in an offscreen document so long downloads keep running while the service worker sleeps, and hands finished files to the downloads API as Blob URLs. |
| `storage` | Stores the user's settings, the list of media detected on each tab (session storage) and the short-lived link list of the batch download page. |
| `unlimitedStorage` | Partially downloaded files are kept in the extension's private storage (OPFS) so downloads can be paused and resumed. Large files such as videos and disk images need more than the default quota. |
| `webRequest` | Observes the address and response headers (content type and size) of media requests on the pages the user visits, to list the videos, audio streams and M3U8 playlists that can be downloaded. Requests are never blocked or modified. |
| `declarativeNetRequestWithHostAccess` | Sets the Referer and Origin headers on the extension's own download requests, because many sites reject media requests without them. The rules only match requests made by the extension itself. |
| `contextMenus` | Adds right-click items such as "Download link with Shuttle DM", "Download all links on this page" and "Save page as MHTML". |
| `scripting` | Collects the links on the current page when the user opens "Batch download", saves a page as HTML, and adds the "Download video" button to tabs that were already open when the extension was installed. |
| `pageCapture` | Saves the current page as a single MHTML file when the user chooses "Save page". |
| `notifications` | Tells the user when a download finishes or fails. This can be turned off in Settings. |
| Host permission `<all_urls>` | Users download files and videos from any website. The extension must request those addresses (with several Range requests in parallel), read their response headers, notice media requests on the pages the user visits, and show the "Download video" button on web videos. It does not read or change page content for any other purpose. |

## Remote code

> No, I am not using remote code. All JavaScript, including the bundled mux.js library, is included in the package.

## Data usage

Chrome Web Store asks for disclosure even when data is only handled on the user's device. Shuttle DM handles the following categories, **only locally and only for its single purpose**:

- [x] **Web history** — the address and title of the page a download came from are kept in the local download list; media requests seen on each tab are kept in session storage until the tab closes.
- [x] **User activity** — network requests are observed to detect downloadable media, and the pointer position is used to show the "Download video" button over a video.
- [x] **Website content** — files, videos and pages the user downloads or saves, and the links listed on the batch download page.

Not handled: personally identifiable information, health information, financial and payment information, authentication information, personal communications, location.

Certify all three statements:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Privacy policy URL

```
https://github.com/SAOCSB/shuttle-dm/blob/main/PRIVACY.md
```
