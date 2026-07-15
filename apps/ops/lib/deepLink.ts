// PR350 — open Taobao / Tmall product links directly in the Taobao app on a phone.
// Tapping an https://…taobao.com / …tmall.com link on iOS opens Safari, which then
// prompts a fresh login for every product. The Taobao app is already signed in, so on a
// mobile device we hand off to the `taobao://` scheme instead — the app registers both
// the taobao.com and tmall.com hosts, so the same item opens straight in the app. On
// desktop (no app) we leave the normal web link untouched.

// hosts the Taobao app handles under its custom scheme (Taobao + Tmall, incl. subdomains)
function isTaobaoHost(host: string): boolean {
  const h = host.replace(/^www\./, '').toLowerCase();
  return h === 'taobao.com' || h.endsWith('.taobao.com')
    || h === 'tmall.com' || h.endsWith('.tmall.com');
}

// the `taobao://` deep-link variant of a Taobao/Tmall URL, or null if it isn't one.
export function taobaoDeepLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!isTaobaoHost(u.hostname)) return null;
    // keep host + path + query + hash, just swap the scheme → the app opens the same item.
    return `taobao://${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch { return null; }
}

// true on phones/tablets where the Taobao app can handle the scheme (iOS incl. iPadOS, Android).
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports as a Mac ("MacIntel") but exposes touch points.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

// onClick for a Taobao/Tmall <a>: on mobile, hand off to the app instead of Safari.
// The anchor keeps its normal https href, so desktop, copy-link and long-press all work.
export function openViaTaobaoApp(e: { preventDefault: () => void }, url: string): void {
  if (!isMobileDevice()) return;            // desktop → follow the normal web link
  const deep = taobaoDeepLink(url);
  if (!deep) return;                        // not a Taobao/Tmall link → leave as-is
  e.preventDefault();
  window.location.href = deep;
}
