'use client';

// PR180 — a global route-transition progress bar. App Router navigations (Next <Link> clicks, deep
// links) can take a beat while the server renders the next screen; this gives immediate feedback. It
// starts when an internal link is clicked and completes when the pathname actually changes. In-page
// tabs are client state (instant) and don't route, so they intentionally don't trigger it.

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'start' | 'grow' | 'done';

export default function NavProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const prevPath = useRef(pathname);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function begin() {
    if (phaseRef.current === 'start' || phaseRef.current === 'grow') return; // already running
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setPhase('start'); // mounted at width 0
    // two rAFs so the browser paints width:0 before we transition to the grow width
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (phaseRef.current === 'start') setPhase('grow');
    }));
    // failsafe: a nav that never changes the pathname (e.g. same-path ?query= change) would otherwise
    // leave the bar stuck at 90% — auto-complete after a beat.
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    safetyTimer.current = setTimeout(finish, 8000);
  }
  function finish() {
    if (safetyTimer.current) { clearTimeout(safetyTimer.current); safetyTimer.current = null; }
    if (phaseRef.current === 'idle' || phaseRef.current === 'done') return; // nothing running
    setPhase('done'); // snap to 100% + fade
    hideTimer.current = setTimeout(() => setPhase('idle'), 320);
  }

  // start on any left-click of an internal, same-tab link that changes the URL
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || a.target === '_blank' || a.hasAttribute('download')) return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return; // external
      if (url.pathname === window.location.pathname && url.search === window.location.search) return; // same page
      begin();
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // complete when the route (pathname) actually changes
  useEffect(() => {
    if (prevPath.current !== pathname) {
      prevPath.current = pathname;
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
  }, []);

  if (phase === 'idle') return null;
  return (
    <div className={`navprog navprog-${phase}`} aria-hidden="true">
      <div className="navprog-bar" />
    </div>
  );
}
