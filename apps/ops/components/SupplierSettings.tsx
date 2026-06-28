'use client';

// Settings → Suppliers (PR81). Manages the `suppliers` table that the Purchasing → To-forwarder
// supplier dropdown reads from: flag emoji, name, country, type. Country drives the unit-cost
// currency filler (China → ¥ yuan, Japan → ¥ yen, …) and the "Taobao ID" field on a To-forwarder
// card, so keep it spelled the way the currency map expects ("China", "Japan", …).

import { useState } from 'react';
import { addSupplier, deleteSupplier, updateSupplier } from '@/app/purchasing/actions';
import type { Supplier, SupplierType } from '@jigzle/db/types';

const SUPPLIER_TYPES: SupplierType[] = ['Taobao account', 'agent', 'marketplace', 'other'];

export default function SupplierSettings({ initial, embedded = false }: { initial: Supplier[]; embedded?: boolean }) {
  const [rows, setRows] = useState<Supplier[]>(initial);
  const [busy, setBusy] = useState(false);
  // notice tone: ok (green) = additive, err (red) = removed/failed, warn (yellow) = neutral edit.
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  // inline add form
  const [adding, setAdding] = useState<{ name: string; flag: string; country: string; type: SupplierType } | null>(null);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  async function save(id: number, patch: Partial<Pick<Supplier, 'name' | 'flag' | 'country' | 'type'>>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateSupplier(id, patch);
      setRows((prev) => prev.map((r) => (r.supplier_id === id ? updated : r)));
      note('warn', 'Saved.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function submitAdd() {
    if (!adding) return;
    const name = adding.name.trim();
    if (!name) { note('err', 'Supplier name is required.'); return; }
    setBusy(true); setNotice(null);
    try {
      const sup = await addSupplier({ name, flag: adding.flag.trim() || null, country: adding.country.trim() || null, type: adding.type });
      setRows((prev) => (prev.some((r) => r.supplier_id === sup.supplier_id) ? prev : [...prev, sup]).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
      setAdding(null);
      note('ok', 'Added a supplier.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function remove(id: number) {
    setBusy(true); setNotice(null);
    try {
      await deleteSupplier(id);
      setRows((prev) => prev.filter((r) => r.supplier_id !== id));
      note('err', 'Removed.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  function sortAZ() {
    setRows((prev) => prev.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })));
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Suppliers</div>}
      <div className="set-sec-sub">Where you buy from. Shown (flag + name) in the Purchasing → To-forwarder supplier picker. Country sets the unit-cost currency and the Taobao field (use “China”, “Japan”, …).</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {rows.length === 0 && <div className="hint">No suppliers yet — add one below.</div>}
        {rows.map((s) => (
          <SupplierRow key={s.supplier_id} sup={s} busy={busy} onSave={(patch) => save(s.supplier_id, patch)} onRemove={() => remove(s.supplier_id)} />
        ))}
      </div>

      {adding ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">+ add supplier</div>
          <input type="text" placeholder="name (e.g. 1688-zhang)" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" placeholder="flag 🇨🇳" value={adding.flag} onChange={(e) => setAdding({ ...adding, flag: e.target.value })} style={{ width: 90 }} />
            <input type="text" placeholder="country (e.g. China)" value={adding.country} onChange={(e) => setAdding({ ...adding, country: e.target.value })} style={{ flex: 1 }} />
          </div>
          <select value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value as SupplierType })}>
            {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAdding(null)} disabled={busy}>cancel</button>
            <button className="btn-secondary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-secondary" onClick={() => setAdding({ name: '', flag: '', country: '', type: 'Taobao account' })} disabled={busy}>+ Add supplier</button>
          <button className="btn-secondary" onClick={sortAZ} disabled={busy || rows.length < 2}>Sort A–Z</button>
        </div>
      )}
    </Wrap>
  );
}

// one editable supplier row: flag · name · country · type (saved on blur/change), Remove.
function SupplierRow({
  sup,
  busy,
  onSave,
  onRemove,
}: {
  sup: Supplier;
  busy: boolean;
  onSave: (patch: Partial<Pick<Supplier, 'name' | 'flag' | 'country' | 'type'>>) => void;
  onRemove: () => void;
}) {
  const [flag, setFlag] = useState(sup.flag ?? '');
  const [name, setName] = useState(sup.name ?? '');
  const [country, setCountry] = useState(sup.country ?? '');

  // save a text field only if it actually changed against the server row.
  const blur = (key: 'flag' | 'name' | 'country', value: string) => {
    const cur = sup[key] ?? '';
    if (value.trim() === String(cur)) return;
    if (key === 'name' && !value.trim()) { setName(sup.name ?? ''); return; } // name is required — revert a blank
    onSave({ [key]: value.trim() || null } as Partial<Pick<Supplier, 'name' | 'flag' | 'country'>>);
  };

  return (
    <div className="set-row">
      <div className="set-fields">
        <div className="set-f sup-flag">
          <label>Flag</label>
          <input type="text" value={flag} placeholder="🇨🇳" onChange={(e) => setFlag(e.target.value)} onBlur={(e) => blur('flag', e.target.value)} disabled={busy} />
        </div>
        <div className="set-f grow">
          <label>Name</label>
          <input type="text" value={name} placeholder="name" onChange={(e) => setName(e.target.value)} onBlur={(e) => blur('name', e.target.value)} disabled={busy} />
        </div>
        <div className="set-f">
          <label>Country</label>
          <input type="text" value={country} placeholder="China" onChange={(e) => setCountry(e.target.value)} onBlur={(e) => blur('country', e.target.value)} disabled={busy} />
        </div>
        <div className="set-f">
          <label>Type</label>
          <select value={sup.type ?? 'other'} onChange={(e) => onSave({ type: e.target.value as SupplierType })} disabled={busy}>
            {SUPPLIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="set-row-ctl">
        <button className="btn-link" onClick={onRemove} disabled={busy}>Remove</button>
      </div>
    </div>
  );
}
