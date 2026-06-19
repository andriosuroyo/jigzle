'use client';

// Scan mode (docs/016 §2B; scanner-first rework docs/PR22) — a keyboard-wedge scanner is the primary
// control. Layout top→bottom: two-line header · Add (no-barcode/new items) · always-on Scan field with
// a 🔊 mute toggle · a review strip for anything that isn't a clean count · two collapsible A–Z lists
// (Unscanned / Scanned). Each scan = +1 (bump); a length/shape guard + EAN check digit rejects garbled
// or merged-double scans BEFORE the server call, holding them for review instead of silently dropping.
// Audio (useScanSound): an ACK chirp fires only AFTER the count write resolves (so the operator paces
// by the beep), a REJECT buzz on anything held. Close is blocked while the review strip is non-empty.
// Behavior-preserving where it matters: record_count / add_missing_sku / close_stock_check / CloseConfirm
// and the per-non-zero-delta adjustment write at close are all UNCHANGED — this reworks Scan only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import CloseConfirm from '@/components/CloseConfirm';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import ScanReviewStrip from '@/components/ScanReviewStrip';
import type { DoubleSplit, Held, HeldKind } from '@/components/ScanReviewStrip';
import { useScanSound } from '@/components/useScanSound';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  getSessionLines,
  recordCount,
  resolveScan,
} from '@/app/stock-check/actions';
import { modeLabel, modeVerb } from '@/app/stock-check/types';
import type {
  CloseConfirmData,
  CloseReviewEntry,
  LineRow,
  ScanResolve,
  ScanSku,
  SessionRow,
} from '@/app/stock-check/types';

// Length/shape guard thresholds (PR22 §2), grounded in the cleaned barcode data: standard codes are
// numeric 8–14 digits (mostly EAN-13/UPC-A); a merged double scan is ~20–28; a single half is 10–13.
const BC_MIN = 8;
const BC_MAX = 14;
const MERGE_MIN = 20;
const MERGE_MAX = 28;
const PART_MIN = 10;
const PART_MAX = 13;
const SPLIT_MAX_TRIES = 6; // cap split candidates tried (each = 2 parallel resolves) when hunting a clean double-split
const MUTE_KEY = 'sc-scan-muted';

type ScanOutcome = 'counted' | 'collision' | 'unknown' | 'garbled' | 'double' | 'error';
interface ScanLogEntry {
  id: number;
  raw: string;
  outcome: ScanOutcome;
  ts: number;
}

// EAN-13 / UPC-A check digit. Caller guarantees a 12- or 13-digit numeric string. Weights run 3,1,3,1…
// from the right of the data digits — correct for both 12-digit UPC-A and 13-digit EAN-13.
function eanOk(code: string): boolean {
  const d: number[] = [];
  for (let i = 0; i < code.length; i++) d.push(code.charCodeAt(i) - 48);
  const check = d[d.length - 1];
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

// Every split of a long numeric paste where BOTH halves are valid barcode lengths (PART_MIN..PART_MAX),
// scored so splits whose halves pass the EAN check digit are tried first (the most likely true double).
function splitCandidates(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = PART_MIN; i <= raw.length - PART_MIN; i++) {
    const a = raw.slice(0, i);
    const b = raw.slice(i);
    if (a.length >= PART_MIN && a.length <= PART_MAX && b.length >= PART_MIN && b.length <= PART_MAX) {
      out.push([a, b]);
    }
  }
  const score = (p: string) => ((p.length === 12 || p.length === 13) && eanOk(p) ? 1 : 0);
  out.sort((x, y) => score(y[0]) + score(y[1]) - (score(x[0]) + score(x[1])));
  return out;
}

export default function CountSession({
  session,
  onExit,
  onClosed,
}: {
  session: SessionRow;
  onExit: () => void;
  onClosed: () => void;
}) {
  const [lines, setLines] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);
  const [muted, setMuted] = useState(false); // default ON (sound plays) — overridden by localStorage on mount

  const [showUnscanned, setShowUnscanned] = useState(true);
  const [showScanned, setShowScanned] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [headH, setHeadH] = useState(0); // measured session-header height → sticky offset for list headers

  const [gateMsg, setGateMsg] = useState<string | null>(null); // "N scans still need review" close warning
  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const inflight = useRef<Set<Promise<unknown>>>(new Set()); // in-flight count writes; close awaits them
  const queueRef = useRef<string[]>([]); // submitted scans waiting to process (serialized — no race, no drop)
  const drainingRef = useRef(false); // a drain loop is running
  const drainPromiseRef = useRef<Promise<void> | null>(null); // the in-progress drain → openClose awaits it
  const heldIdRef = useRef(0); // monotonic id for held items (stable React keys, dismissal)
  const heldRef = useRef<Held[]>([]); // latest held — read after awaits, where the `held` closure is stale
  const scanLogIdRef = useRef(0); // stable React key for scan-log rows

  const sound = useScanSound(muted);

  useEffect(() => {
    void reload();
    try {
      const v = localStorage.getItem(MUTE_KEY);
      if (v != null) setMuted(v === '1');
    } catch {
      /* private mode / no storage — keep the default */
    }
    sound.unlock(); // session-open tap → unlock the AudioContext so the first real scan already plays
    // Desktop / fine-pointer (or a Bluetooth scanner): focus the scan field. Phones don't auto-focus
    // (no keyboard popped); the operator taps it when ready.
    const fine = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer:fine)').matches;
    if (fine) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // measure the (wrapping, possibly-sticky) session header so the list sub-headers can stick just below
  // it on mobile (where the header is sticky). Desktop header isn't sticky → list headers use top:0.
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const measure = () => setHeadH(el.offsetHeight);
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // mirror `held` into a ref (read after awaits in openClose, where the closure is stale) and clear the
  // stale "still need review" close warning whenever the strip empties.
  useEffect(() => {
    heldRef.current = held;
    if (held.length === 0) setGateMsg(null);
  }, [held]);

  async function reload(): Promise<LineRow[]> {
    setLoading(true);
    setError(null);
    try {
      const l = await getSessionLines(session.stock_check_id);
      setLines(l);
      return l;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the session.');
      return lines;
    } finally {
      setLoading(false);
    }
  }

  const imgCodes = useMemo(() => {
    const set = new Set(lines.map((l) => l.item_code));
    for (const h of held) {
      h.skus?.forEach((s) => set.add(s.item_code));
      if (h.split) {
        set.add(h.split.skuA.item_code);
        set.add(h.split.skuB.item_code);
      }
    }
    return [...set];
  }, [lines, held]);
  const imgMap = useSkuImages(imgCodes);

  // increment a SKU by 1 (scan / + / pick / accept-double). Local update when the line exists; reload
  // when a brand-new (out-of-scope) line was just created. Returns the new qty (null on failure) so the
  // caller can show "→ qty N" and gate the ACK sound on a successful write.
  async function bump(itemCode: string): Promise<number | null> {
    setError(null);
    const exists = lines.some((l) => l.item_code === itemCode);
    const p = recordCount(session.stock_check_id, itemCode, 'inc', 1);
    inflight.current.add(p);
    try {
      const newQty = await p;
      if (exists) {
        setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: newQty, confirmed: true } : l)));
      } else {
        await reload();
      }
      return newQty;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Count failed.');
      return null;
    } finally {
      inflight.current.delete(p);
    }
  }

  async function setQty(itemCode: string, qty: number) {
    setError(null);
    const v = Math.max(0, Math.floor(qty));
    const p = recordCount(session.stock_check_id, itemCode, 'set', v);
    inflight.current.add(p);
    try {
      await p;
      setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: v, confirmed: true } : l)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      inflight.current.delete(p);
    }
  }

  // ── scan pipeline ──────────────────────────────────────────────────────────
  // Enter submits: clear the field, enqueue, and drain serially. The queue (+ the single drain loop)
  // means rapid wedge bursts can't race or drop — each scan fully processes before the next.
  function submitScan() {
    const raw = scan.trim();
    if (!raw) return;
    setScan('');
    setGateMsg(null);
    sound.unlock();
    queueRef.current.push(raw);
    // start a drain if none is running; an in-progress loop picks the new item up itself (queueRef is shared).
    if (!drainingRef.current) drainPromiseRef.current = drain();
  }

  async function drain() {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length) {
        const raw = queueRef.current.shift() as string;
        await processScan(raw);
      }
    } finally {
      drainingRef.current = false;
      drainPromiseRef.current = null;
      inputRef.current?.focus();
    }
  }

  // Length/shape guard BEFORE any server call, then resolve. Anything not a clean count → reject sound
  // + held for review (never silently dropped).
  async function processScan(raw: string) {
    if (/^\d+$/.test(raw)) {
      const n = raw.length;
      if (n >= BC_MIN && n <= BC_MAX) {
        if ((n === 12 || n === 13) && !eanOk(raw)) {
          rejectHold('garbled', raw);
          return;
        }
        await resolveAndApply(raw);
        return;
      }
      if (n >= MERGE_MIN && n <= MERGE_MAX) {
        sound.playReject();
        const split = await trySplit(raw); // resolve attempt for the "accept as 2" action
        hold({ kind: 'double', raw, split });
        setScanMsg(`✗ double? ${raw} — needs review`);
        logScan(raw, 'double');
        return;
      }
      rejectHold('garbled', raw); // numeric but an impossible length
      return;
    }
    // contains non-digits (internal/self codes) → skip the guard, resolve directly
    await resolveAndApply(raw);
  }

  async function resolveAndApply(raw: string) {
    let res: ScanResolve;
    try {
      res = await resolveScan(raw);
    } catch (e) {
      sound.playReject();
      setScanMsg(e instanceof Error ? e.message : 'scan failed');
      logScan(raw, 'error');
      return;
    }
    if (res.status === 'resolved') {
      const qty = await bump(res.sku.item_code);
      if (qty == null) {
        sound.playReject(); // the count write failed — bump already surfaced the error
        logScan(raw, 'error');
        return;
      }
      sound.playAck(); // ONLY after the write resolves → the beep is the throughput governor
      setScanMsg(`✓ ${res.sku.item_code} +1 → qty ${qty}`);
      logScan(raw, 'counted');
    } else if (res.status === 'collision') {
      sound.playReject();
      hold({ kind: 'collision', raw, skus: res.skus });
      setScanMsg(`⚠ ${raw} → ${res.skus.length} SKUs — needs review`);
      logScan(raw, 'collision');
    } else {
      sound.playReject();
      hold({ kind: 'unknown', raw });
      setScanMsg(`✗ unknown ${raw} — needs review`);
      logScan(raw, 'unknown');
    }
  }

  // try splits (best-scored first) until both halves resolve to a SKU; cap the round-trips.
  async function trySplit(raw: string): Promise<DoubleSplit | null> {
    const cands = splitCandidates(raw);
    let tried = 0;
    for (const [a, b] of cands) {
      if (tried++ >= SPLIT_MAX_TRIES) break;
      try {
        const [ra, rb] = await Promise.all([resolveScan(a), resolveScan(b)]);
        if (ra.status === 'resolved' && rb.status === 'resolved') {
          return { a, b, skuA: ra.sku, skuB: rb.sku };
        }
      } catch {
        /* try the next split */
      }
    }
    return null;
  }

  function hold(h: { kind: HeldKind; raw: string; skus?: ScanSku[]; split?: DoubleSplit | null }) {
    const id = `h${heldIdRef.current++}`;
    setHeld((hs) => [...hs, { id, ts: Date.now(), ...h }]);
  }

  function rejectHold(kind: 'garbled', raw: string) {
    sound.playReject();
    hold({ kind, raw });
    setScanMsg(`✗ ${kind} ${raw} — needs review`);
    logScan(raw, kind);
  }

  function dismissHeld(id: string) {
    setHeld((hs) => hs.filter((h) => h.id !== id));
  }

  function logScan(raw: string, outcome: ScanOutcome) {
    setScanLog((l) => [{ id: scanLogIdRef.current++, raw, outcome, ts: Date.now() }, ...l].slice(0, 200));
  }

  // ── review-strip actions ─────────────────────────────────────────────────────
  async function acceptDouble(h: Held) {
    if (!h.split) return;
    dismissHeld(h.id);
    const qa = await bump(h.split.skuA.item_code);
    const qb = await bump(h.split.skuB.item_code);
    if (qa != null && qb != null) {
      sound.playAck();
      setScanMsg(`✓ ${h.split.skuA.item_code} +1, ${h.split.skuB.item_code} +1`);
    }
  }

  async function pickHeld(h: Held, sku: ScanSku) {
    dismissHeld(h.id);
    const q = await bump(sku.item_code);
    if (q != null) {
      sound.playAck();
      setScanMsg(`✓ ${sku.item_code} +1 → qty ${q}`);
    }
  }

  async function addSku(code: string): Promise<boolean> {
    setError(null);
    try {
      await addMissingSku(session.stock_check_id, code, 1); // adds the line at qty 1; operator corrects in-list
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed.');
      return false;
    }
  }

  // resolving an 'unknown' held scan (quick-add) → same audible ACK the pick / accept-as-2 paths give.
  async function addUnknown(code: string) {
    const ok = await addSku(code);
    if (ok) {
      sound.playAck();
      setScanMsg(`✓ added ${code} +1`);
    }
  }

  async function openClose() {
    // Finish processing any queued/draining scans FIRST — the queue is the earliest stage and a scan
    // still in it has fired no write yet, so inflight alone wouldn't catch it; a late +1 must never land
    // after the close snapshot the operator confirms against.
    if (drainPromiseRef.current) await drainPromiseRef.current;
    // Block close while anomalies are still held — nothing is silently lost (PR22 §5). Read via the ref
    // because draining above may have surfaced new holds after this closure captured `held`.
    if (heldRef.current.length) {
      const n = heldRef.current.length;
      setGateMsg(`${n} scan${n === 1 ? '' : 's'} still need review — resolve or dismiss before closing.`);
      return;
    }
    // The qty field commits on blur; tapping Close blurs it, firing a setQty. Await any in-flight count
    // write so the lines we close against include that last edit (no lost count). Close math is unchanged.
    if (inflight.current.size) await Promise.allSettled([...inflight.current]);
    const fresh = await reload();
    const countDeltas = fresh
      .filter((l) => l.counted_qty != null && l.counted_qty - l.physical !== 0)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical, counted: l.counted_qty as number, delta: (l.counted_qty as number) - l.physical }));
    const decisions = fresh
      .filter((l) => l.counted_qty == null)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical }));
    setConfirm({ mode: 'count', countDeltas, decisions, added: [] });
    setCloseErr(null);
  }

  async function doCancel() {
    if (!window.confirm('Cancel this count? Nothing will be saved and the scope is freed.')) return;
    setError(null);
    try {
      await cancelStockCheck(session.stock_check_id);
      onExit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed.');
    }
  }

  async function doClose(review: CloseReviewEntry[]) {
    setClosing(true);
    setCloseErr(null);
    try {
      await closeStockCheck(session.stock_check_id, review);
      onClosed();
    } catch (e) {
      setCloseErr(e instanceof Error ? e.message : 'Close failed.');
      setClosing(false);
    }
  }

  function toggleMute() {
    setMuted((m) => {
      const nv = !m;
      try {
        localStorage.setItem(MUTE_KEY, nv ? '1' : '0');
      } catch {
        /* ignore */
      }
      return nv;
    });
    sound.unlock();
  }

  const counted = lines.filter((l) => l.counted_qty != null);
  const toCount = lines.filter((l) => l.counted_qty == null);
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  // A–Z by brand_prefix then item_code (PR18 §3 — consistency with Checkbox grouping).
  const byCode = (a: LineRow, b: LineRow) =>
    (a.brand_prefix ?? '—').localeCompare(b.brand_prefix ?? '—') || a.item_code.localeCompare(b.item_code);
  const shownToCount = [...toCount].sort(byCode);
  const shownCounted = [...counted].sort(byCode);

  return (
    <div className="sc-wrap" style={{ '--sc-head-h': `${headH}px` } as CSSProperties}>
      <div className="sc-sess-head" ref={headRef}>
        <div className="sc-sess-row1">
          <button className="btn-link" onClick={onExit}>← back</button>
          <span className="sc-prog">{counted.length} / {lines.length} SKUs</span>
          <span className="sc-sess-actions">
            <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
            <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close</button>
          </span>
        </div>
        <div className="sc-sess-row2">
          {modeLabel(session.mode)} · {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')} · {modeVerb(session.mode)} {session.counted_by}
          {session.note ? ` · ${session.note}` : ''}
        </div>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}
      {gateMsg && <div className="validation warn" style={{ marginTop: 12 }}>{gateMsg}</div>}

      {/* Add a no-barcode / brand-new SKU (autosearch → tap to add at qty 1; or inline quick-add). */}
      <SkuSearchAdd listed={listed} onSelect={(code) => void addSku(code)} />

      {/* Scan — always visible, the primary control. Enter submits; 🔊 mutes the audio feedback. */}
      <div className="sc-scanrow">
        <input
          ref={inputRef}
          type="text"
          className="rcv-shipid sc-scaninput"
          placeholder="Scan a barcode"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onFocus={() => sound.unlock()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitScan(); } }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          className="sc-mute"
          aria-label={muted ? 'unmute scan sounds' : 'mute scan sounds'}
          title={muted ? 'Sound off — tap to unmute' : 'Sound on — tap to mute'}
          onClick={toggleMute}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
      {scanMsg && <div className="sc-scanmsg">{scanMsg}</div>}

      <ScanReviewStrip
        held={held}
        imgMap={imgMap}
        onAcceptDouble={(h) => void acceptDouble(h)}
        onPick={(h, sku) => void pickHeld(h, sku)}
        onAddUnknown={(_h, code) => void addUnknown(code)}
        onDismiss={dismissHeld}
      />

      {loading ? (
        <div className="sc-empty">Loading…</div>
      ) : (
        <>
          <section className="sc-listsec">
            <button className="sc-listhead" onClick={() => setShowUnscanned((v) => !v)} aria-expanded={showUnscanned}>
              <span className="sc-caret">{showUnscanned ? '▾' : '▸'}</span> Unscanned ({toCount.length})
            </button>
            {showUnscanned && (shownToCount.length === 0 ? (
              <div className="sc-empty">Everything in scope has been scanned.</div>
            ) : (
              shownToCount.map((l) => <CountRow key={l.line_id} line={l} imgMap={imgMap} onSet={setQty} onInc={(c) => void bump(c)} />)
            ))}
          </section>

          <section className="sc-listsec">
            <button className="sc-listhead" onClick={() => setShowScanned((v) => !v)} aria-expanded={showScanned}>
              <span className="sc-caret">{showScanned ? '▾' : '▸'}</span> Scanned ({counted.length})
            </button>
            {showScanned && (shownCounted.length === 0 ? (
              <div className="sc-empty">Nothing scanned yet.</div>
            ) : (
              shownCounted.map((l) => <CountRow key={l.line_id} line={l} imgMap={imgMap} onSet={setQty} onInc={(c) => void bump(c)} />)
            ))}
          </section>

          {scanLog.length > 0 && (
            <div className="sc-scanlog">
              <button className="sc-scanlog-toggle" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
                {showLog ? '▾' : '▸'} scan log ({scanLog.length})
              </button>
              {showLog && (
                <ul className="sc-scanlog-list">
                  {scanLog.map((e) => (
                    <li key={e.id} className="sc-scanlog-row">
                      <span className={`sc-scanlog-out ${e.outcome === 'counted' ? 'ok' : 'bad'}`}>{e.outcome}</span>
                      <span className="sc-scanlog-raw">{e.raw}</span>
                      <span className="sc-exp">{new Date(e.ts).toLocaleTimeString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {confirm && (
        <CloseConfirm
          data={confirm}
          busy={closing}
          error={closeErr}
          onConfirm={(review) => void doClose(review)}
          onCancel={() => { if (!closing) setConfirm(null); }}
        />
      )}
    </div>
  );
}

// One working-list row (used for both Unscanned and Scanned). The number field is the primary control:
// a local draft committed on blur/Enter, so typing a multi-digit count doesn't fire a write per
// keystroke (and doesn't move the row between sections mid-type). −/+ are small corrections; the quick
// "= system" / "0" buttons stay on un-scanned rows.
function CountRow({
  line,
  imgMap,
  onSet,
  onInc,
}: {
  line: LineRow;
  imgMap: ReturnType<typeof useSkuImages>;
  onSet: (code: string, qty: number) => void;
  onInc: (code: string) => void;
}) {
  const counted = line.counted_qty != null;
  const [draft, setDraft] = useState(counted ? String(line.counted_qty) : '');
  useEffect(() => {
    setDraft(line.counted_qty == null ? '' : String(line.counted_qty));
  }, [line.counted_qty]);

  const d = counted ? (line.counted_qty as number) - line.physical : 0;

  function commit() {
    const t = draft.trim();
    if (t === '') return; // empty → leave as-is (an un-scanned row stays un-scanned)
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setDraft(counted ? String(line.counted_qty) : '');
      return;
    }
    const v = Math.max(0, Math.floor(n));
    if (counted && v === line.counted_qty) return; // no change
    onSet(line.item_code, v);
  }

  return (
    <div className={`sc-count-row${counted ? '' : ' dim'}`}>
      <div className="sc-row-top">
        <SkuImage status={imgMap[line.item_code]?.status} displayUrl={imgMap[line.item_code]?.displayUrl} name={line.name} size={36} />
        <span className="sc-row-id">
          <span className="ff-code">{line.item_code}</span>
          <span className="ff-name">{line.name}</span>
        </span>
        {counted && d !== 0 && <span className={`sc-delta ${d > 0 ? 'pos' : 'neg'}`}>{d > 0 ? `+${d}` : d}</span>}
      </div>
      <div className="sc-row-ctl">
        {/* The editable qty field stands alone (PR16 §3) — no read-only label. The "= N" quick button
            (un-scanned) and the delta badge (scanned) carry the system-qty reference. */}
        <span className="sc-ctlrow">
          {/* onMouseDown preventDefault keeps focus in the qty field, so a stepper click doesn't also
              blur-commit the draft → exactly one deterministic write per action. */}
          <button className="sc-step" aria-label="minus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, (line.counted_qty ?? 0) - 1)}>−</button>
          <input
            type="number"
            inputMode="numeric"
            className="sc-qty"
            min={0}
            placeholder="count"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          />
          <button className="sc-step" aria-label="plus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onInc(line.item_code)}>+</button>
        </span>
        {!counted && (
          <span className="sc-quick">
            <button className="btn-secondary sc-mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, line.physical)}>= {line.physical}</button>
            <button className="btn-secondary sc-mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, 0)}>0</button>
          </span>
        )}
      </div>
    </div>
  );
}
