'use client';

// Settings → Shipping → Export couriers (PR191). Manages settings_export_couriers — the pick-list shown
// in Sales → Fulfill when the ship-to is outside Indonesia (Repack, DHL, FedEx…). Each row has a label,
// an active toggle, and a "needs address" checkbox: tick it for couriers that receive the parcel first
// at their own intermediary address (Repack) and fill in that address; leave it unticked for
// integrators that pick up locally (DHL/FedEx). Self-loads its list on mount.

import { useEffect, useState } from 'react';
import { TruckIcon } from '@/components/AddIcons';
import { addExportCourier, deleteExportCourier, getExportCouriers, reorderExportCouriers, updateExportCourier } from '@/app/settings/actions';
import type { ExportCourier } from '@/app/settings/types';
import IconCell from '@/components/IconCell';
import { useOverlayClose } from '@/components/useOverlayClose';

export default function ExportCourierSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<ExportCourier[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addLabel, setAddLabel] = useState<string | null>(null);
  // PR — the per-row edit overlay: active / needs-address / address moved off the row into an overlay.
  type EditDraft = Pick<ExportCourier, 'is_active' | 'needs_address' | 'addr_recipient' | 'addr_phone' | 'addr_text'>;
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const editRow = rows.find((r) => r.id === editingId) ?? null;

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

  function openEdit(r: ExportCourier) {
    setEditingId(r.id);
    setDraft({ is_active: r.is_active, needs_address: r.needs_address, addr_recipient: r.addr_recipient, addr_phone: r.addr_phone, addr_text: r.addr_text });
  }
  function closeEdit() { setEditingId(null); setDraft(null); }
  const editDirty = !!(editRow && draft) && (
    draft.is_active !== editRow.is_active ||
    draft.needs_address !== editRow.needs_address ||
    (draft.addr_recipient ?? '') !== (editRow.addr_recipient ?? '') ||
    (draft.addr_phone ?? '') !== (editRow.addr_phone ?? '') ||
    (draft.addr_text ?? '') !== (editRow.addr_text ?? '')
  );
  const editClose = useOverlayClose({ open: editingId !== null, onClose: closeEdit, dirty: editDirty });
  async function saveEdit() {
    if (editingId == null || !draft) return;
    // if "needs address" is off, the address fields are irrelevant — persist them as null.
    const p: Partial<EditDraft> = draft.needs_address
      ? { ...draft, addr_recipient: draft.addr_recipient?.trim() || null, addr_phone: draft.addr_phone?.trim() || null, addr_text: draft.addr_text?.trim() || null }
      : { is_active: draft.is_active, needs_address: false, addr_recipient: null, addr_phone: null, addr_text: null };
    await patch(editingId, p);
    closeEdit();
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
              <IconCell value={r.icon} disabled={busy} onChange={(v) => patch(r.id, { icon: v })} />
              <input className="exc-label" type="text" defaultValue={r.label} placeholder="courier name" disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.label) patch(r.id, { label: v }); }} />
              {!r.is_active && <span className="exc-off">inactive</span>}
              {r.needs_address && <span className="exc-tag">address</span>}
              <div className="set-row-ctl">
                <button className="set-edit" aria-label="Edit" title="Edit" onClick={() => openEdit(r)} disabled={busy}>✎</button>
                <button className="set-arrow" aria-label="Move up" onClick={() => move(i, -1)} disabled={busy || i === 0}>▲</button>
                <button className="set-arrow" aria-label="Move down" onClick={() => move(i, 1)} disabled={busy || i === rows.length - 1}>▼</button>
                <button className="set-del" aria-label="Remove" onClick={() => remove(r.id)} disabled={busy}>✕</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* per-row edit overlay — active toggle + address block, keeping the row itself clean */}
      {editRow && draft && (
        <div className="sc-modal-backdrop" onClick={editClose.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Edit export courier" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{editRow.label || 'Export courier'}</span>
              <button className="sc-modal-x" onClick={editClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="exc-toggles">
                <label className="exc-chk"><input type="checkbox" checked={draft.is_active} disabled={busy} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} /> Active</label>
                <label className="exc-chk"><input type="checkbox" checked={draft.needs_address} disabled={busy} onChange={(e) => setDraft({ ...draft, needs_address: e.target.checked })} /> Needs address</label>
              </div>
              {draft.needs_address && (
                <div className="exc-addr" style={{ marginTop: 4 }}>
                  <div className="po-field"><label>Recipient name</label>
                    <input type="text" placeholder="recipient name" value={draft.addr_recipient ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, addr_recipient: e.target.value })} /></div>
                  <div className="po-field"><label>Phone</label>
                    <input type="text" placeholder="phone" value={draft.addr_phone ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, addr_phone: e.target.value })} /></div>
                  <div className="po-field"><label>Full address</label>
                    <textarea placeholder="full address" rows={3} value={draft.addr_text ?? ''} disabled={busy} onChange={(e) => setDraft({ ...draft, addr_text: e.target.value })} /></div>
                </div>
              )}
              <div className="confirm-actions" style={{ marginTop: 8 }}>
                <button className="btn-primary" onClick={saveEdit} disabled={busy}>Save changes</button>
                <button className="btn-secondary" onClick={editClose.requestClose} disabled={busy}>Cancel</button>
              </div>
            </div>
          </div>
          {editClose.confirm}
        </div>
      )}

      {addLabel !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">Add export courier</div>
          <input type="text" placeholder="courier name (e.g. Repack)" value={addLabel} autoFocus disabled={busy}
            onChange={(e) => setAddLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddLabel(null)} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown btn-ico" onClick={() => setAddLabel('')} disabled={busy}><TruckIcon />Add export courier</button>
        </div>
      )}
    </Wrap>
  );
}
