'use client';

// Settings → Forwarders (PR123). Manages the `forwarders` table the Purchasing → To-ship group panel
// reads from. Each forwarder is a flag (picked from a country dropdown — stores the emoji + derives the
// country), an immutable prefix (the ship_id prefix / PK: SUB, MTE, LGB, IMA, …) and an optional name
// (e.g. "Superbuy", "Mentari Timur Ekspress"). Rows reorder with ▲▼ and delete (soft) with ✕, mirroring
// Settings → Suppliers. The prefix can't be edited after creation — it's the join key for shipments.

import { useState } from 'react';
import { addForwarder, deleteForwarder, reorderForwarders, updateForwarder } from '@/app/purchasing/actions';
import type { Forwarder } from '@jigzle/db/types';
import FlagSelect from '@/components/FlagSelect';

export default function ForwarderSettings({ initial, embedded = false }: { initial: Forwarder[]; embedded?: boolean }) {
  const [rows, setRows] = useState<Forwarder[]>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [adding, setAdding] = useState<{ prefix: string; name: string; flag: string; country: string } | null>(null);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  async function save(prefix: string, patch: Partial<Pick<Forwarder, 'name' | 'flag' | 'country'>>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateForwarder(prefix, patch);
      setRows((prev) => prev.map((r) => (r.prefix === prefix ? updated : r)));
      note('warn', 'Saved.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function persistOrder(next: Forwarder[]) {
    setBusy(true); setNotice(null);
    try {
      await reorderForwarders(next.map((r) => r.prefix));
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
    const next = rows.slice().sort((a, b) => a.prefix.localeCompare(b.prefix, undefined, { sensitivity: 'base' }));
    setRows(next);
    void persistOrder(next);
  }

  async function submitAdd() {
    if (!adding) return;
    const prefix = adding.prefix.trim().toUpperCase();
    if (!prefix) { note('err', 'A prefix is required (e.g. SUB).'); return; }
    if (rows.some((r) => r.prefix.toUpperCase() === prefix)) { note('err', `${prefix} already exists.`); return; }
    setBusy(true); setNotice(null);
    try {
      const fwd = await addForwarder({ prefix, name: adding.name.trim() || null, flag: adding.flag || null, country: adding.country || null });
      setRows((prev) => (prev.some((r) => r.prefix === fwd.prefix) ? prev.map((r) => (r.prefix === fwd.prefix ? fwd : r)) : [...prev, fwd]));
      setAdding(null);
      note('ok', 'Added a forwarder.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function remove(prefix: string) {
    setBusy(true); setNotice(null);
    try {
      await deleteForwarder(prefix);
      setRows((prev) => prev.filter((r) => r.prefix !== prefix));
      note('err', 'Removed.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Forwarders</div>}
      <div className="set-sec-sub">Freight forwarders, shown (flag + prefix) in the To-ship group panel. The prefix is the ship-id series (SUB, MTE, LGB, IMA, …) — new ship ids auto-number from the last one. The flag sets the country.</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {rows.length > 0 && (
          <div className="set-colhead set-colhead-sup" aria-hidden>
            <div className="sup-flag-cell">Flag</div>
            <div className="set-fields"><div className="set-f fwd-prefix-cell">Prefix</div><div className="set-f grow">Name</div></div>
            <div className="set-colhead-ctl" />
          </div>
        )}
        {rows.length === 0 && <div className="hint">No forwarders yet — add one below.</div>}
        {rows.map((f, i) => (
          <ForwarderRow
            key={f.prefix}
            fwd={f}
            busy={busy}
            first={i === 0}
            last={i === rows.length - 1}
            onSave={(patch) => save(f.prefix, patch)}
            onMove={(dir) => move(i, dir)}
            onRemove={() => remove(f.prefix)}
          />
        ))}
      </div>

      {adding ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">+ add forwarder</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="sup-flag-cell">
              <FlagSelect value={adding.flag || null} onChange={({ flag, country }) => setAdding((a) => (a ? { ...a, flag, country } : a))} />
            </div>
            <input type="text" placeholder="prefix (e.g. SUB)" value={adding.prefix} onChange={(e) => setAdding((a) => (a ? { ...a, prefix: e.target.value.toUpperCase() } : a))} style={{ width: 120 }} />
            <input type="text" placeholder="name (e.g. “Superbuy”)" value={adding.name} onChange={(e) => setAdding((a) => (a ? { ...a, name: e.target.value } : a))} style={{ flex: 1 }} />
          </div>
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAdding(null)} disabled={busy}>cancel</button>
            <button className="btn-secondary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-secondary" onClick={() => setAdding({ prefix: '', name: '', flag: '', country: '' })} disabled={busy}>+ Add forwarder</button>
          <button className="btn-secondary" onClick={sortAZ} disabled={busy || rows.length < 2}>Sort A–Z</button>
        </div>
      )}
    </Wrap>
  );
}

// one editable forwarder row: flag picker · prefix (read-only, PK) · name · ▲▼ reorder · ✕ remove.
function ForwarderRow({
  fwd,
  busy,
  first,
  last,
  onSave,
  onMove,
  onRemove,
}: {
  fwd: Forwarder;
  busy: boolean;
  first: boolean;
  last: boolean;
  onSave: (patch: Partial<Pick<Forwarder, 'name' | 'flag' | 'country'>>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(fwd.name ?? '');

  function blurName(value: string) {
    const v = value.trim();
    if (v === (fwd.name ?? '')) return;
    onSave({ name: v || null });
  }

  return (
    <div className="set-row set-row-sup">
      <div className="sup-flag-cell">
        <FlagSelect value={fwd.flag} onChange={({ flag, country }) => onSave({ flag, country })} disabled={busy} />
      </div>
      <div className="set-fields">
        <div className="set-f fwd-prefix-cell">
          <span className="fwd-prefix" title="The ship-id prefix can't be changed">{fwd.prefix}</span>
        </div>
        <div className="set-f grow">
          <input type="text" value={name} placeholder="forwarder name" onChange={(e) => setName(e.target.value)} onBlur={(e) => blurName(e.target.value)} disabled={busy} />
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
