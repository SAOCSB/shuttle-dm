# Privacy Policy — Shuttle DM

_Last updated: 14 October 2026_

Shuttle DM ("the extension") is a download manager for Chrome and Edge. This policy explains what the extension does with data. [简体中文版本见下方](#隐私政策--飞梭下载器)。

## Summary

- **The extension does not collect, sell or share any personal data.** It has no analytics, no tracking, no ads and no accounts.
- **Everything happens in your browser.** Downloads, video merging and page saving run locally. Nothing is sent to the developer or to any third-party server.

## Data stored on your device

The extension stores the following in your browser's local extension storage. It never leaves your device:

| Data | Where | How long |
| --- | --- | --- |
| Your settings (connections per download, speed limit, folders, takeover rules…) | `chrome.storage.local` | Until you uninstall the extension |
| The download list (file names, addresses, source page, progress, status) | IndexedDB of the extension | Until you remove the task from the list |
| Partially downloaded data | The extension's private file system (OPFS) | Deleted when the download finishes or is removed |
| Media detected on each tab (addresses of video/audio requests) | `chrome.storage.session` | Cleared when the tab closes or the browser exits |

Finished files are saved by the browser to your downloads folder, like any other download.

## Network requests

The extension only makes network requests in order to download what you ask for:

- the files, videos and pages you choose to download, including downloads you hand over from the browser;
- playlists and the first bytes of media files that the page you are viewing has already requested, so it can show the available qualities and sizes.

These requests go directly to the website that hosts the content. Like the page itself, they may include that site's cookies and the address of the page (Referer), because many sites require them. The extension does not send this information anywhere else.

## Permissions

The extension asks only for permissions it needs to work as a download manager: managing downloads, detecting media requests on pages, setting the Referer header on its own requests, saving pages, context menus, notifications and local storage. A detailed explanation of each permission is in [`store/privacy-practices.md`](store/privacy-practices.md).

## Unsupported content

The extension does not download videos from YouTube and does not try to get around DRM (for example Widevine, FairPlay or PlayReady). Please only download content you have the right to save.

## Changes and contact

If this policy changes, the new version will be published in this repository with a new date. Questions can be asked by opening an issue at <https://github.com/SAOCSB/shuttle-dm/issues>.

---

# 隐私政策 — 飞梭下载器

_更新日期：2026 年 10 月 14 日_

飞梭下载器（以下简称“本扩展”）是一个 Chrome / Edge 下载管理器。本政策说明本扩展如何处理数据。

## 概要

- **本扩展不收集、不出售、不分享任何个人数据。** 没有统计分析、没有跟踪、没有广告，也不需要账号。
- **所有处理都在你的浏览器里完成。** 下载、视频合并、网页保存都在本机运行，不会把任何数据发送给开发者或任何第三方服务器。

## 保存在你设备上的数据

以下数据只保存在浏览器为本扩展分配的本地存储中，不会离开你的设备：

| 数据 | 位置 | 保存期限 |
| --- | --- | --- |
| 设置（连接数、限速、保存文件夹、接管规则等） | `chrome.storage.local` | 直到卸载扩展 |
| 下载列表（文件名、下载地址、来源网页、进度、状态） | 扩展的 IndexedDB | 直到你从列表中删除该任务 |
| 下载中的临时数据 | 扩展的私有文件系统（OPFS） | 下载完成或删除任务后清除 |
| 每个标签页检测到的媒体（音视频请求的地址） | `chrome.storage.session` | 关闭标签页或退出浏览器时清除 |

下载完成的文件由浏览器保存到你的下载文件夹，与普通下载相同。

## 网络请求

本扩展只为下载你要求的内容而发出网络请求：

- 你选择下载的文件、视频和网页，以及你交给本扩展接管的浏览器下载；
- 当前网页已经请求过的播放列表和媒体文件开头的少量数据，用于显示可选清晰度和文件大小。

这些请求直接发往内容所在的网站。与网页本身一样，请求中可能带有该网站的 Cookie 和来源网页地址（Referer），因为很多网站需要它们。本扩展不会把这些信息发送到任何其他地方。

## 权限

本扩展只申请作为下载管理器所必需的权限：管理下载、检测网页中的媒体请求、为自己发出的请求设置 Referer、保存网页、右键菜单、通知和本地存储。每项权限的详细说明见 [`store/privacy-practices.md`](store/privacy-practices.md)。

## 不支持的内容

本扩展不下载 YouTube 上的视频，也不会尝试绕过 DRM（如 Widevine、FairPlay、PlayReady）。请只下载你有权保存的内容。

## 变更与联系

本政策如有变更，会在本仓库发布新版本并更新日期。如有问题，请在 <https://github.com/SAOCSB/shuttle-dm/issues> 提交 issue。
