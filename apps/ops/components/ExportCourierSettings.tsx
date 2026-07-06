'use client';

// Settings → Shipping → Export couriers (PR191). Manages settings_export_couriers — the pick-list shown
// in Sales → Fulfill when the ship-to is outside Indonesia (Repack, DHL, FedEx…). Each row has a label,
// an active toggle, and a "needs address" checkbox: tick it for couriers that receive the parcel first
// at their own intermediary address (Repack) and fill in that address; leave it unticked for
// integrators that pick up locally (DHL/FedEx). Self-loads its list on mount.

import { useEffect, useState } from 'react';
import { addExportCourier, deleteExportCourier, getExportCouriers, reorderExportCouriers, updateExportCourier } from '@/app/settings/actions';
import type { ExportCourier } from '@/app/settings/types';

export default function ExportCourierSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<ExportCourier[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addLabel, setAddLabel] = useState<string | null>(null);

  useEffect(() => {
    getExportCouriers().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });

  async function patch(id: number, p: Partial<ExportCourier>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateExportCourier(id, p);
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      setNotice({ tone: 'warn', text: 'Saved.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function persistOrder(next: ExportCourier[]) {
    setBusy(true);
    try { await reorderExportCouriers(next.map((r) => r.id)); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
    void persistOrder(next);
  }
  async function submitAdd() {
    const label = (addLabel ?? '').trim();
    if (!label) { setNotice({ tone: 'err', text: 'A courier name is required.' }); return; }
    if (rows.some((r) => r.label.toLowerCase() === label.toLowerCase())) { setNotice({ tone: 'err', text: `${label} already exists.` }); return; }
    setBusy(true); setNotice(null);
    try {
      const row = await addExportCourier({ label });
      setRows((prev) => [...prev, row]);
      setAddLabel(null);
      setNotice({ tone: 'ok', text: 'Added.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    setBusy(true); setNotice(null);
    try { await deleteExportCourier(id); setRows((prev) => prev.filter((r) => r.id !== id)); setNotice({ tone: 'err', text: 'Removed.' }); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Export couriers</div>}
      <div className="set-sec-sub">Couriers for international/export shipments, shown in Sales → Fulfill when the ship-to is outside Indonesia. Tick “needs address” for a courier that receives the parcel first at its own address (e.g. Repack) and fill it in; leave it off for local-pickup carriers (DHL, FedEx).</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && rows.length === 0 && <div className="hint">No export couriers yet — add one below.</div>}
        {rows.map((r, i) => (
          <div key={r.id} className="set-row exc-row">
            <div className="exc-main">
              <input className="exc-label" type="text" defaultValue={r.label} placeholder="courier name" disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.label) patch(r.id, { label: v }); }} />
              <label className="exc-chk"><input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => patch(r.id, { is_active: e.target.checked })} /> active</label>
              <label className="exc-chk"><input type="checkbox" checked={r.needs_address} disabled={busy} onChange={(e) => patch(r.id, { needs_address: e.target.checked })} /> needs address</label>
              <div className="set-row-ctl">
                <button className="set-arrow" aria-label="Move up" onClick={() => move(i, -1)} disabled={busy || i === 0}>▲</button>
                <button className="set-arrow" aria-label="Move down" onClick={() => move(i, 1)} disabled={busy || i === rows.length - 1}>▼</button>
                <button className="set-del" aria-label="Remove" onClick={() => remove(r.id)} disabled={busy}>✕</button>
              </div>
            </div>
            {r.needs_address && (
              <div className="exc-addr">
                <input type="text" placeholder="recipient name" defaultValue={r.addr_recipient ?? ''} disabled={busy}
                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.addr_recipient ?? null)) patch(r.id, { addr_recipient: v }); }} />
                <input type="text" placeholder="phone" defaultValue={r.addr_phone ?? ''} disabled={busy}
                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.addr_phone ?? null)) patch(r.id, { addr_phone: v }); }} />
                <textarea placeholder="full address" rows={2} defaultValue={r.addr_text ?? ''} disabled={busy}
                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.addr_text ?? null)) patch(r.id, { addr_text: v }); }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {addLabel !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">+ add export courier</div>
          <input type="text" placeholder="courier name (e.g. Repack)" value={addLabel} autoFocus disabled={busy}
            onChange={(e) => setAddLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddLabel(null)} disabled={busy}>cancel</button>
            <button className="btn-secondary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-secondary" onClick={() => setAddLabel('')} disabled={busy}>+ Add export courier</button>
        </div>
      )}
    </Wrap>
  );
}
