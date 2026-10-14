// Sites where video detection and downloading are switched off.
// Their terms of service don't allow downloading their videos, and Chrome Web Store policy doesn't
// allow extensions to help with it. content/content.js and the exclude_matches in manifest.json keep
// the same list; update them together.

import { i18n } from './i18n.js';

const VIDEO_BLOCKED_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'googlevideo.com'];

export const blockedSiteMessage = () => i18n('blockedSiteMessage');

export function isVideoBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return !!h && VIDEO_BLOCKED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

export function isVideoBlockedUrl(url) {
  if (!url) return false;
  try {
    return isVideoBlockedHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
