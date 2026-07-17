'use client';

// Settings → Doc Generator → CN addresses (PR356). Manages settings_cn_addresses — the pick-list the
// CN Invoice's shipper AND consignee selectors both draw from (one list on purpose: a consignee today
// may be a shipper tomorrow). Each row is a label + a full name/address block (newlines allowed, may be
// Chinese). Self-loads its list on mount; degrades quietly until 0095 is applied.

import { useEffect, useState } from 'react';
import { MapPinIcon } from '@/components/AddIcons';
import { addCnAddress, deleteCnAddress, getCnAddresses, reorderCnAddresses, updateCnAddress } from '@/app/settings/actions';
import type { CnAddress } from '@/app/settings/types';

export default function CnAddressSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<CnAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addLabel, setAddLabel] = useState<string | null>(null);

  useEffect(() => {
    getCnAddresses().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });

  async function patch(id: number, p: Partial<CnAddress>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateCnAddress(id, p);
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      setNotice({ tone: 'warn', text: 'Saved.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function persistOrder(next: CnAddress[]) {
    setBusy(true);
    try { await reorderCnAddresses(next.map((r) => r.id)); } catch (e) { fail(e); } finally { setBusy(false); }
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
    if (!label) { setNotice({ tone: 'err', text: 'A label is required.' }); return; }
    if (rows.some((r) => r.label.toLowerCase() === label.toLowerCase())) { setNotice({ tone: 'err', text: `${label} already exists.` }); return; }
    setBusy(true); setNotice(null);
    try {
      const row = await addCnAddress({ label });
      setRows((prev) => [...prev, row]);
      setAddLabel(null);
      setNotice({ tone: 'ok', text: 'Added.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    setBusy(true); setNotice(null);
    try { await deleteCnAddress(id); setRows((prev) => prev.filter((r) => r.id !== id)); setNotice({ tone: 'err', text: 'Removed.' }); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">CN addresses</div>}
      <div className="set-sec-sub">Named addresses for the CN Invoice. Both the shipper and consignee pickers draw from this one list — a party that is a consignee today may be a shipper tomorrow. Each row is a short label plus the full name &amp; address block (line breaks and Chinese are fine).</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && rows.length === 0 && <div className="hint">No addresses yet — add one below.</div>}
        {rows.map((r, i) => (
          <div key={r.id} className="set-row exc-row">
            <div className="exc-main">
              <input className="exc-label" type="text" defaultValue={r.label} placeholder="label (e.g. MTE)" disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.label) patch(r.id, { label: v }); }} />
              <label className="exc-chk"><input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => patch(r.id, { is_active: e.target.checked })} /> active</label>
              <div className="set-row-ctl">
                <button className="set-arrow" aria-label="Move up" onClick={() => move(i, -1)} disabled={busy || i === 0}>▲</button>
                <button className="set-arrow" aria-label="Move down" onClick={() => move(i, 1)} disabled={busy || i === rows.length - 1}>▼</button>
                <button className="set-del" aria-label="Remove" onClick={() => remove(r.id)} disabled={busy}>✕</button>
              </div>
            </div>
            <div className="exc-addr">
              <textarea placeholder="full name & address block" rows={3} defaultValue={r.address ?? ''} disabled={busy}
                onBlur={(e) => { const v = e.target.value; if (v !== (r.address ?? '')) patch(r.id, { address: v }); }} />
            </div>
          </div>
        ))}
      </div>

      {addLabel !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">Add CN address</div>
          <input type="text" placeholder="label (e.g. MTE)" value={addLabel} autoFocus disabled={busy}
            onChange={(e) => setAddLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddLabel(null)} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown btn-ico" onClick={() => setAddLabel('')} disabled={busy}><MapPinIcon />Add CN address</button>
        </div>
      )}
    </Wrap>
  );
}
