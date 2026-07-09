'use client';

// PR259 — a tiny localStorage-backed draft store so in-progress work survives ANY reload. The main
// cause we're guarding against: a deploy to `main` (a PR merge) ships a new build, and Next.js
// force-reloads every already-open tab on its next Server Action / navigation to reconcile the new
// bundle — wiping in-memory counts/forms for everyone, not just whoever merged. The Refresh button,
// an iOS PWA relaunch, an auth bounce, or a crash do the same. Persisting drafts here makes all of
// those non-destructive: the work is re-read after the reload.
//
// Generic key→value with a savedAt stamp + max-age prune; callers own their keys and payload shape.
// SSR / private-mode safe: every access is guarded and swallows quota / security errors (a failed
// save is best-effort, never throws into the UI).

type Wrapped<T> = { savedAt: number; data: T };

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // prune drafts older than 30 days on read

function store(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // access itself can throw in some privacy modes
  }
}

export function saveDraft<T>(key: string, data: T): void {
  const ls = store();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify({ savedAt: Date.now(), data } as Wrapped<T>));
  } catch {
    /* quota / serialization — non-fatal; the draft is best-effort */
  }
}

export function loadDraft<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | null {
  const ls = store();
  if (!ls) return null;
  let raw: string | null = null;
  try { raw = ls.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as Wrapped<T>;
    if (!w || typeof w.savedAt !== 'number') { clearDraft(key); return null; }
    if (Date.now() - w.savedAt > maxAgeMs) { clearDraft(key); return null; }
    return w.data;
  } catch {
    clearDraft(key); // corrupt value → drop it
    return null;
  }
}

export function clearDraft(key: string): void {
  const ls = store();
  if (!ls) return;
  try { ls.removeItem(key); } catch { /* ignore */ }
}

// keys currently present under a prefix — powers "you have N saved drafts" affordances. Prunes nothing.
export function listDraftKeys(prefix: string): string[] {
  const ls = store();
  if (!ls) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* ignore */ }
  return out;
}
