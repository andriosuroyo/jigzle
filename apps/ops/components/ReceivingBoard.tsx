'use client';

import { useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import type { ExpectedLine, InboundLabel, ReceiveLine, ReceiveQueueRow } from '@jigzle/db/types';
import {
  getReceiveQueue,
  getShipmentForReceive,
  resolveBarcode,
  searchSkus,
  createCatalogueStub,
  newAdhocShipId,
  recordReceipt,
} from '@/app/receiving/actions';
import type { ReceiveDetail, ResolvedSku, RecordReceiptResult, SkuHit } from '@/app/receiving/types';

const LABELS: (InboundLabel | '')[] = ['', 'Exclude', 'Hold', 'Tokopedia'];

function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// the synthetic detail for an ad-hoc receive (no shipments-ledger row, no expected list)
const ADHOC_SENTINEL = '__adhoc__';

export default function ReceivingBoard({
  initialQueue,
  userEmail,
}: {
  initialQueue: ReceiveQueueRow[];
  userEmail: string;
}) {
  const [queue, setQueue] = useState<ReceiveQueueRow[]>(initialQueue);
  const [selected, setSelected] = useState<string | null>(null); // ship_id, or ADHOC_SENTINEL
  const [detail, setDetail] = useState<ReceiveDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const reqIdRef = useRef(0);

  const [mode, setMode] = useState<'shipment' | 'adhoc'>('shipment');
  const [adhocShipId, setAdhocShipId] = useState('');

  // what physically arrived, keyed by item_code (1 line → 1 inbound row on save)
  const [received, setReceived] = useState<Map<string, ReceiveLine>>(new Map());

  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<ResolvedSku[] | null>(null);
  const [stub, setStub] = useState<{ barcode: string; item_code: string; name: string; brand: string } | null>(null);

  const [skuQuery, setSkuQuery] = useState('');
  const [skuHits, setSkuHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [receiveDate, setReceiveDate] = useState(todayStr());
  const [closeShipment, setCloseShipment] = useState(true);

  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(RecordReceiptResult & { units: number; closed: boolean }) | null>(null);

  // barcode → expected item_code(s). Composite barcode model (0020): a barcode can link to many
  // SKUs, so this maps to a LIST. The fast path only fires when exactly ONE expected SKU owns the
  // scanned code; a shared barcode (>1 owner) defers to the server resolveBarcode so the collision
  // picker shows — never silently attributing the scan to one arbitrary owner.
  const barcodeMap = useMemo(() => {
    const m = new Map<string, string[]>();
    detail?.barcodes.forEach((b) => {
      const owners = m.get(b.barcode);
      if (owners) {
        if (!owners.includes(b.item_code)) owners.push(b.item_code);
      } else {
        m.set(b.barcode, [b.item_code]);
      }
    });
    return m;
  }, [detail]);
  const expectedNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    detail?.expected.forEach((e) => {
      if (e.item_code) m.set(e.item_code, e.name);
    });
    return m;
  }, [detail]);

  function resetDraft() {
    setReceived(new Map());
    setScan('');
    setScanMsg(null);
    setPicker(null);
    setStub(null);
    setSkuQuery('');
    setSkuHits([]);
    setReceiveDate(todayStr());
    setResult(null);
    setError(null);
  }

  async function openShipment(shipId: string) {
    const myReq = ++reqIdRef.current;
    setSelected(shipId);
    setMode('shipment');
    setAdhocShipId('');
    setDetail(null);
    resetDraft();
    setCloseShipment(true);
    setLoadingDetail(true);
    try {
      const d = await getShipmentForReceive(shipId);
      if (reqIdRef.current !== myReq) return; // superseded by a newer selection
      setDetail(d);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load shipment.');
    } finally {
      if (reqIdRef.current === myReq) setLoadingDetail(false);
    }
  }

  async function startAdhoc() {
    const myReq = ++reqIdRef.current;
    setSelected(ADHOC_SENTINEL);
    setMode('adhoc');
    setDetail({ ship_id: '', origin_country: null, ship_date: null, tracking: null, is_shipment: false, expected: [], barcodes: [] });
    resetDraft();
    setCloseShipment(false);
    setAdhocShipId('');
    setLoadingDetail(true);
    try {
      const id = await newAdhocShipId();
      if (reqIdRef.current !== myReq) return;
      setAdhocShipId(id);
    } catch (e) {
      if (reqIdRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to allocate an ad-hoc id.');
    } finally {
      if (reqIdRef.current === myReq) setLoadingDetail(false);
    }
  }

  // ── received-lines mutators ──
  function addUnit(item_code: string, name: string, delta = 1) {
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(item_code);
      next.set(item_code, cur ? { ...cur, qty: cur.qty + delta } : { item_code, name, qty: delta, excluded: false, label: null, dimension_weight: null });
      return next;
    });
  }
  function receiveExpected(e: ExpectedLine) {
    if (!e.item_code) return;
    const qty = e.expected_qty > 0 ? e.expected_qty : 1;
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(e.item_code!);
      next.set(e.item_code!, cur ? { ...cur, qty } : { item_code: e.item_code!, name: e.name, qty, excluded: false, label: null, dimension_weight: null });
      return next;
    });
  }
  function setField(item_code: string, patch: Partial<ReceiveLine>) {
    setReceived((prev) => {
      const next = new Map(prev);
      const cur = next.get(item_code);
      if (cur) next.set(item_code, { ...cur, ...patch });
      return next;
    });
  }
  function removeReceived(item_code: string) {
    setReceived((prev) => {
      const next = new Map(prev);
      next.delete(item_code);
      return next;
    });
  }

  // ── scan → preloaded map, else server resolveBarcode (collision / not-found) ──
  async function doScan() {
    const code = scan.trim();
    if (!code || !detail) return;
    setScan('');
    setPicker(null);
    setStub(null);

    const owners = barcodeMap.get(code);
    if (owners && owners.length === 1) {
      addUnit(owners[0], expectedNameByCode.get(owners[0]) ?? owners[0]);
      setScanMsg(`✓ ${owners[0]} +1`);
      return;
    }
    // 0 expected owners, or >1 (a shared barcode) → server resolve: resolved / collision picker / not-found
    try {
      const res = await resolveBarcode(code);
      if (res.status === 'resolved') {
        addUnit(res.sku.item_code, res.sku.name);
        setScanMsg(`✓ ${res.sku.item_code} +1`);
      } else if (res.status === 'collision') {
        setPicker(res.skus);
        setScanMsg(`⚠ barcode ${code} → ${res.skus.length} SKUs — pick one`);
      } else {
        setStub({ barcode: code, item_code: '', name: '', brand: '' });
        setScanMsg(`unknown barcode ${code} — add a new SKU`);
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'scan failed');
    }
  }

  function pick(sku: ResolvedSku) {
    addUnit(sku.item_code, sku.name);
    setScanMsg(`✓ ${sku.item_code} +1`);
    setPicker(null);
  }

  async function createStub() {
    if (!stub) return;
    const item_code = stub.item_code.trim();
    if (!item_code) {
      setScanMsg('enter an item code for the new SKU');
      return;
    }
    try {
      const hit = await createCatalogueStub({ item_code, name: stub.name.trim(), brand_prefix: stub.brand.trim() || null, barcode: stub.barcode });
      addUnit(hit.item_code, hit.name);
      setScanMsg(`✓ stub ${hit.item_code} created (needs review) +1`);
      setStub(null);
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'stub creation failed');
    }
  }

  async function runSearch() {
    const q = skuQuery.trim();
    if (q.length < 2) {
      setSkuHits([]);
      return;
    }
    setSearching(true);
    try {
      setSkuHits(await searchSkus(q));
    } catch {
      setSkuHits([]);
    } finally {
      setSearching(false);
    }
  }

  // ── expected vs received, merged ──
  const expectedByCode = useMemo(() => {
    const m = new Map<string, ExpectedLine>();
    detail?.expected.forEach((e) => {
      if (e.item_code) m.set(e.item_code, e);
    });
    return m;
  }, [detail]);
  const expectedUnresolved = useMemo(() => (detail?.expected ?? []).filter((e) => !e.item_code), [detail]);
  const extras = useMemo(
    () => [...received.values()].filter((l) => !expectedByCode.has(l.item_code)).sort((a, b) => a.name.localeCompare(b.name)),
    [received, expectedByCode]
  );
  const expectedResolved = useMemo(
    () => [...expectedByCode.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [expectedByCode]
  );

  const receivedList = [...received.values()];
  const totalUnits = receivedList.reduce((s, l) => s + (l.excluded ? 0 : l.qty), 0);
  const sellableUnits = receivedList.filter((l) => !l.excluded).reduce((s, l) => s + l.qty, 0);
  const saveLines = receivedList.filter((l) => l.qty !== 0);
  const shipIdForSave = mode === 'adhoc' ? adhocShipId.trim() : detail?.ship_id ?? '';

  function badgeFor(exp: number, got: number): { cls: string; text: string } {
    if (exp > 0 && got === 0) return { cls: 'miss', text: '✗ missing' };
    if (exp === 0 && got !== 0) return { cls: 'extra', text: '⚠ extra' };
    if (got < exp) return { cls: 'short', text: '⚠ short' };
    if (got > exp) return { cls: 'over', text: '✓ over' };
    return { cls: 'match', text: '✓ match' };
  }

  async function commit() {
    if (!detail) return;
    if (!shipIdForSave) {
      setError('A ship id is required (the ad-hoc id, a shipment, or free text).');
      return;
    }
    if (saveLines.length === 0) {
      setError('Add at least one received line (a non-zero qty).');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const willClose = mode === 'shipment' && closeShipment;
      const res = await recordReceipt({
        ship_id: shipIdForSave,
        receive_date: receiveDate,
        close_shipment: willClose,
        lines: saveLines.map((l) => ({
          item_code: l.item_code,
          qty: l.qty,
          excluded: l.excluded,
          label: l.label,
          dimension_weight: l.dimension_weight?.trim() || null,
        })),
      });
      setResult({ ...res, units: sellableUnits, closed: willClose });
      // the inbound rows are now persisted — clear the draft so nothing is double-counted
      setReceived(new Map());
      // refresh the queue; drop the shipment if it was closed
      try {
        setQueue(await getReceiveQueue());
      } catch {
        /* keep current queue on transient error */
      }
      if (willClose) {
        setDetail(null);
        setSelected(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setCommitting(false);
    }
  }

  const headerTitle = mode === 'adhoc' ? 'Ad-hoc receive' : detail?.ship_id ?? '';

  return (
    <div className="ops">
      <AppHeader active="receiving" userEmail={userEmail} />

      <div className="fulfill-layout">
        {/* ── Arrivals queue ── */}
        <aside className="fq-pane">
          <div className="fq-head"><span>Arrivals</span></div>
          <div style={{ padding: '6px 6px 0' }}>
            <button className={`fq-row ${selected === ADHOC_SENTINEL ? 'active' : ''}`} onClick={startAdhoc} style={{ borderStyle: 'dashed' }}>
              <div className="fq-row-top"><span className="fq-id">+ ad-hoc receive</span></div>
              <div className="fq-row-bot"><span>goods with no shipment ledger entry (📦)</span></div>
            </button>
          </div>
          {queue.length === 0 && <div className="hint fq-empty">No open shipments.</div>}
          <ul className="fq-list">
            {queue.map((q) => (
              <li key={q.ship_id}>
                <button className={`fq-row ${selected === q.ship_id ? 'active' : ''}`} onClick={() => openShipment(q.ship_id)}>
                  <div className="fq-row-top">
                    <span className="fq-id">{q.ship_id}</span>
                    <span className="fq-cust">{q.origin_country || '—'}</span>
                  </div>
                  <div className="fq-row-bot">
                    <span>{q.ship_date || 'no ship date'}</span>
                    <span className="badge ready" style={{ marginLeft: 'auto' }}>
                      {q.expected_count > 0 ? `${q.expected_count} expected` : 'no list'}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Receive detail ── */}
        <main className="fd-pane">
          {!selected && <div className="fd-empty">Select a shipment to receive, or start an ad-hoc receive.</div>}
          {selected && loadingDetail && <div className="fd-empty">Loading…</div>}

          {detail && (
            <>
              <div className="fd-head">
                <div className="fd-title">{headerTitle}</div>
                <div className="fd-sub">
                  {mode === 'shipment' ? (
                    <>
                      {detail.origin_country || '—'}
                      {detail.ship_date ? ` · ${detail.ship_date}` : ''}
                      {detail.tracking ? ` · ${detail.tracking}` : ''}
                      {!detail.is_shipment && <span className="warn-text"> · not in the shipment ledger</span>}
                    </>
                  ) : (
                    <>goods with no shipment ledger entry</>
                  )}
                </div>
              </div>

              {error && <div className="validation err">{error}</div>}
              {result && (
                <div className="validation ok">
                  Received {result.units} sellable unit{result.units === 1 ? '' : 's'}.{' '}
                  {result.closed ? 'Shipment → completed. ' : 'Shipment left open. '}
                  {result.stock.map((s) => `${s.item_code}: avail ${s.available}, physical ${s.physical}`).join(' · ')}
                </div>
              )}

              {/* Ad-hoc id (editable; operator can override with free text) */}
              {mode === 'adhoc' && (
                <section className="fd-section">
                  <div className="fd-section-head">Ad-hoc ship id</div>
                  <input
                    type="text"
                    className="rcv-shipid"
                    value={adhocShipId}
                    onChange={(e) => setAdhocShipId(e.target.value)}
                    placeholder="📦YYMMXXX or free text"
                  />
                  <div className="hint">Generated 📦YYMMXXX — override with free text if it belongs to a real shipment.</div>
                </section>
              )}

              {/* Scan / add */}
              <section className="fd-section">
                <div className="fd-section-head">Scan / add</div>
                <div className="scan-row">
                  <input
                    type="text"
                    placeholder="scan / type a barcode"
                    value={scan}
                    onChange={(e) => setScan(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doScan(); } }}
                  />
                  <button className="btn-secondary" onClick={doScan}>add</button>
                  {scanMsg && <span className="scan-msg">{scanMsg}</span>}
                </div>

                {/* D1 collision picker */}
                {picker && (
                  <div className="rcv-picker">
                    <div className="rcv-picker-head">⚠ which SKU?</div>
                    {picker.map((s) => (
                      <button key={s.item_code} className="rcv-picker-opt" onClick={() => pick(s)}>
                        <span className="ff-code">{s.item_code}</span>
                        <span className="ff-name">{s.name}</span>
                        {s.is_verified && <span className="badge ready">verified</span>}
                      </button>
                    ))}
                    <button className="btn-link" onClick={() => setPicker(null)}>cancel</button>
                  </div>
                )}

                {/* D2 unknown barcode → minimal stub */}
                {stub && (
                  <div className="rcv-stub">
                    <div className="subform-label">+ add new SKU (flagged needs review)</div>
                    <div className="hint">barcode {stub.barcode}</div>
                    <input type="text" placeholder="item code (brand-prefix convention, e.g. APP-300-358)" value={stub.item_code} onChange={(e) => setStub({ ...stub, item_code: e.target.value })} />
                    <input type="text" placeholder="name" value={stub.name} onChange={(e) => setStub({ ...stub, name: e.target.value })} />
                    <input type="text" placeholder="brand prefix (optional)" value={stub.brand} onChange={(e) => setStub({ ...stub, brand: e.target.value })} />
                    <div className="subform-actions">
                      <button className="btn-link" onClick={() => setStub(null)}>cancel</button>
                      <button className="btn-secondary" onClick={createStub}>create + add</button>
                    </div>
                  </div>
                )}

                {/* manual SKU search */}
                <div className="scan-row" style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="or search SKU by code / name"
                    value={skuQuery}
                    onChange={(e) => setSkuQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
                  />
                  <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'search'}</button>
                </div>
                {skuHits.length > 0 && (
                  <ul className="result-list" style={{ marginTop: 6 }}>
                    {skuHits.map((h) => (
                      <li key={h.item_code}>
                        <button className="result-item" onClick={() => { addUnit(h.item_code, h.name); setSkuHits([]); setSkuQuery(''); }}>
                          <span className="ri-name">{h.item_code} · {h.name}</span>
                          <span className="ri-meta">avail {h.available}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Expected vs received */}
              <section className="fd-section">
                <div className="fd-section-head">Expected vs received</div>
                {detail.expected.length === 0 && extras.length === 0 && (
                  <div className="hint">No expected list — scan or search to add what arrived.</div>
                )}
                <ul className="ff-lines">
                  {expectedResolved.map((e) => {
                    const line = received.get(e.item_code!);
                    const got = line?.qty ?? 0;
                    const b = badgeFor(e.expected_qty, got);
                    return (
                      <li key={`exp-${e.item_code}`} className="ff-line">
                        <div className="rcv-line-head">
                          <span className="ff-code">{e.item_code}</span>
                          <span className="ff-name">{e.name}</span>
                          <span className="rcv-exp">exp {e.expected_qty}</span>
                          <span className={`rcv-badge ${b.cls}`}>{b.text}</span>
                          {!line && <button className="btn-link" onClick={() => receiveExpected(e)}>+ receive</button>}
                        </div>
                        {line && renderControls(line)}
                      </li>
                    );
                  })}

                  {extras.map((line) => {
                    const b = badgeFor(0, line.qty);
                    return (
                      <li key={`got-${line.item_code}`} className="ff-line">
                        <div className="rcv-line-head">
                          <span className="ff-code">{line.item_code}</span>
                          <span className="ff-name">{line.name}</span>
                          <span className={`rcv-badge ${b.cls}`}>{b.text}</span>
                        </div>
                        {renderControls(line)}
                      </li>
                    );
                  })}

                  {expectedUnresolved.map((e, i) => (
                    <li key={`unres-${i}`} className="ff-line">
                      <div className="rcv-line-head">
                        <span className="ff-name">{e.name}</span>
                        <span className="rcv-exp">exp {e.expected_qty}</span>
                        <span className="rcv-badge miss">unresolved — search to map a SKU</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Receive date + close */}
              <section className="fd-section fd-courier">
                <div>
                  <label className="fd-label">Receive date</label>
                  <input type="date" value={receiveDate} onChange={(e) => setReceiveDate(e.target.value)} />
                </div>
                {mode === 'shipment' && detail.is_shipment && (
                  <div style={{ flex: 1 }}>
                    <label className="fd-label">Shipment</label>
                    <label className="rcv-close">
                      <input type="checkbox" checked={closeShipment} onChange={(e) => setCloseShipment(e.target.checked)} />
                      mark completed (leave unchecked for a partial receive)
                    </label>
                  </div>
                )}
              </section>

              {/* Commit bar */}
              <div className="fd-commit">
                <div className="fd-commit-info">
                  Σ receiving <b>{sellableUnits}</b> sellable unit{sellableUnits === 1 ? '' : 's'} across {saveLines.length} line{saveLines.length === 1 ? '' : 's'}
                  {totalUnits !== sellableUnits ? ' · (excluded rows add 0)' : ''}
                </div>
                <button className="btn-primary" onClick={commit} disabled={committing || saveLines.length === 0 || !shipIdForSave}>
                  {committing ? 'Saving…' : 'Save receipt'}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );

  // per-received-line controls: qty (signed) · exclude · label · dim/weight · remove
  function renderControls(line: ReceiveLine) {
    return (
      <div className="rcv-controls">
        <label className="rcv-ctl">
          <span>qty</span>
          <input
            type="number"
            step={1}
            className="rcv-qty"
            value={line.qty}
            onChange={(e) => setField(line.item_code, { qty: Number.isFinite(parseInt(e.target.value, 10)) ? parseInt(e.target.value, 10) : 0 })}
          />
        </label>
        <label className="rcv-ctl rcv-ex">
          <input type="checkbox" checked={line.excluded} onChange={(e) => setField(line.item_code, { excluded: e.target.checked })} />
          <span>exclude</span>
        </label>
        <label className="rcv-ctl">
          <span>label</span>
          <select value={line.label ?? ''} onChange={(e) => setField(line.item_code, { label: (e.target.value || null) as InboundLabel | null })}>
            {LABELS.map((l) => <option key={l || 'none'} value={l}>{l || '—'}</option>)}
          </select>
        </label>
        <input
          type="text"
          className="rcv-dim"
          placeholder="dim / weight (optional)"
          value={line.dimension_weight ?? ''}
          onChange={(e) => setField(line.item_code, { dimension_weight: e.target.value })}
        />
        <button className="li-remove" onClick={() => removeReceived(line.item_code)} aria-label="remove line">×</button>
      </div>
    );
  }
}
