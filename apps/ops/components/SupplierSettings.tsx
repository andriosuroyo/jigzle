'use client';

// Settings → Suppliers (PR88). Manages the `suppliers` table the Purchasing → To-forwarder supplier
// picker reads from. Each supplier is a flag (picked from a country dropdown — stores the emoji and
// derives the country, which drives the unit-cost currency + the Taobao field) and a free-text name
// (e.g. "Taobao: 0811-51-2889", "Amazon JP"). Rows reorder with ▲▼ and delete with ✕, like the other
// settings lists. Country/type are no longer edited here (country is derived from the flag).

import { useState } from 'react';
import { addSupplier, deleteSupplier, reorderSuppliers, updateSupplier } from '@/app/purchasing/actions';
import type { Supplier } from '@jigzle/db/types';
import FlagSelect from '@/components/FlagSelect';

export default function SupplierSettings({ initial, embedded = false }: { initial: Supplier[]; embedded?: boolean }) {
  const [rows, setRows] = useState<Supplier[]>(initial);
  const [busy, setBusy] = useState(false);
  // notice tone: ok (green) = additive, err (red) = removed/failed, warn (yellow) = neutral edit.
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  // inline add form
  const [adding, setAdding] = useState<{ name: string; flag: string; country: string } | null>(null);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  async function save(id: number, patch: Partial<Pick<Supplier, 'name' | 'flag' | 'country'>>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateSupplier(id, patch);
      setRows((prev) => prev.map((r) => (r.supplier_id === id ? updated : r)));
      note('warn', 'Saved.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function persistOrder(next: Supplier[]) {
    setBusy(true); setNotice(null);
    try {
      await reorderSuppliers(next.map((r) => r.supplier_id));
      note('warn', 'Order saved.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[index], next[j]] = [next[j], next[index]];
    setRows(next);
    void persistOrder(next);
  }

  function sortAZ() {
    const next = rows.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    setRows(next);
    void persistOrder(next);
  }

  async function submitAdd() {
    if (!adding) return;
    const name = adding.name.trim();
    if (!name) { note('err', 'Supplier name is required.'); return; }
    setBusy(true); setNotice(null);
    try {
      const sup = await addSupplier({ name, flag: adding.flag || null, country: adding.country || null });
      setRows((prev) => (prev.some((r) => r.supplier_id === sup.supplier_id) ? prev : [...prev, sup]));
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

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Suppliers</div>}
      <div className="set-sec-sub">Where you buy from, shown (flag + name) in the To-forwarder supplier picker. The flag sets the country, which drives the unit-cost currency and the Taobao field.</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {rows.length > 0 && (
          <div className="set-colhead set-colhead-sup" aria-hidden>
            <div className="sup-flag-cell">Flag</div>
            <div className="set-fields"><div className="set-f grow">Name</div></div>
            <div className="set-colhead-ctl" />
          </div>
        )}
        {rows.length === 0 && <div className="hint">No suppliers yet — add one below.</div>}
        {rows.map((s, i) => (
          <SupplierRow
            key={s.supplier_id}
            sup={s}
            busy={busy}
            first={i === 0}
            last={i === rows.length - 1}
            onSave={(patch) => save(s.supplier_id, patch)}
            onMove={(dir) => move(i, dir)}
            onRemove={() => remove(s.supplier_id)}
          />
        ))}
      </div>

      {adding ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">+ add supplier</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="sup-flag-cell">
              <FlagSelect value={adding.flag || null} onChange={({ flag, country }) => setAdding((a) => (a ? { ...a, flag, country } : a))} />
            </div>
            <input type="text" placeholder="name (e.g. “Taobao: 0811-51-2889”)" value={adding.name} onChange={(e) => setAdding((a) => (a ? { ...a, name: e.target.value } : a))} style={{ flex: 1 }} />
          </div>
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAdding(null)} disabled={busy}>cancel</button>
            <button className="btn-secondary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-secondary" onClick={() => setAdding({ name: '', flag: '', country: '' })} disabled={busy}>+ Add supplier</button>
          <button className="btn-secondary" onClick={sortAZ} disabled={busy || rows.length < 2}>Sort A–Z</button>
        </div>
      )}
    </Wrap>
  );
}

// one editable supplier row: flag picker (left) · name (most space) · ▲▼ reorder · ✕ remove.
function SupplierRow({
  sup,
  busy,
  first,
  last,
  onSave,
  onMove,
  onRemove,
}: {
  sup: Supplier;
  busy: boolean;
  first: boolean;
  last: boolean;
  onSave: (patch: Partial<Pick<Supplier, 'name' | 'flag' | 'country'>>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(sup.name ?? '');

  function blurName(value: string) {
    const v = value.trim();
    if (v === (sup.name ?? '')) return;
    if (!v) { setName(sup.name ?? ''); return; } // name is required — revert a blank
    onSave({ name: v });
  }

  return (
    <div className="set-row set-row-sup">
      <div className="sup-flag-cell">
        <FlagSelect value={sup.flag} onChange={({ flag, country }) => onSave({ flag, country })} disabled={busy} />
      </div>
      <div className="set-fields">
        <div className="set-f grow">
          <input type="text" value={name} placeholder="supplier name" onChange={(e) => setName(e.target.value)} onBlur={(e) => blurName(e.target.value)} disabled={busy} />
        </div>
      </div>
      <div className="set-row-ctl">
        <button className="set-arrow" aria-label="Move up" onClick={() => onMove(-1)} disabled={busy || first}>▲</button>
        <button className="set-arrow" aria-label="Move down" onClick={() => onMove(1)} disabled={busy || last}>▼</button>
        <button className="set-del" aria-label="Remove" onClick={onRemove} disabled={busy}>✕</button>
      </div>
    </div>
  );
}
