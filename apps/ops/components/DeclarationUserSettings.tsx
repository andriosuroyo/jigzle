'use client';

// Settings → Purchasing → Declaration users (PR205; overlay redesign PR280). Manages
// settings_declaration_users — the identity pick-list for Doc Generator → SP Declare (Surat Pernyataan).
// Each person carries KTP, NPWP, phone and a per-person address (the address on the declaration changes
// with the signer). The list shows one line per person (read-only name); Edit opens an overlay with all
// five labelled fields. Self-loads on mount.

import { useState, useEffect } from 'react';
import { UserIcon } from '@/components/AddIcons';
import { addDeclarationUser, deleteDeclarationUser, getDeclarationUsers, reorderDeclarationUsers, updateDeclarationUser } from '@/app/settings/actions';
import type { DeclarationUser } from '@/app/settings/types';
import { useOverlayClose } from '@/components/useOverlayClose';

// pencil (Edit) — matches the detail-view edit glyph elsewhere.
const PencilIcon = () => (<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);

type Draft = { name: string; ktp: string; npwp: string; phone: string; address: string };
const toDraft = (r: DeclarationUser): Draft => ({ name: r.name ?? '', ktp: r.ktp ?? '', npwp: r.npwp ?? '', phone: r.phone ?? '', address: r.address ?? '' });

export default function DeclarationUserSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<DeclarationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addName, setAddName] = useState<string | null>(null);
  // the edit overlay: which row, and its editable draft.
  const [editing, setEditing] = useState<DeclarationUser | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: '', ktp: '', npwp: '', phone: '', address: '' });

  useEffect(() => {
    getDeclarationUsers().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });

  // PR307 — the edit overlay holds unsaved draft edits; close (Esc/backdrop/×) confirms discard when the
  // draft diverges from the row it was opened on.
  const editClose = useOverlayClose({ open: editing !== null, onClose: () => { if (!busy) setEditing(null); }, dirty: editing !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(editing)) });

  function openEdit(r: DeclarationUser) {
    setNotice(null);
    setEditing(r);
    setDraft(toDraft(r));
  }

  async function saveEdit() {
    if (!editing) return;
    const name = draft.name.trim();
    if (!name) { setNotice({ tone: 'err', text: 'A name is required.' }); return; }
    if (rows.some((r) => r.id !== editing.id && r.name.toLowerCase() === name.toLowerCase())) {
      setNotice({ tone: 'err', text: `${name} already exists.` }); return;
    }
    setBusy(true); setNotice(null);
    try {
      const updated = await updateDeclarationUser(editing.id, {
        name,
        ktp: draft.ktp.trim() || null,
        npwp: draft.npwp.trim() || null,
        phone: draft.phone.trim() || null,
        address: draft.address.trim() || null,
      });
      setRows((prev) => prev.map((r) => (r.id === editing.id ? updated : r)));
      setEditing(null);
      setNotice({ tone: 'warn', text: 'Saved.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function persistOrder(next: DeclarationUser[]) {
    setBusy(true);
    try { await reorderDeclarationUsers(next.map((r) => r.id)); } catch (e) { fail(e); } finally { setBusy(false); }
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
    const name = (addName ?? '').trim();
    if (!name) { setNotice({ tone: 'err', text: 'A name is required.' }); return; }
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) { setNotice({ tone: 'err', text: `${name} already exists.` }); return; }
    setBusy(true); setNotice(null);
    try {
      const row = await addDeclarationUser(name);
      setRows((prev) => [...prev, row]);
      setAddName(null);
      openEdit(row); // jump straight into the overlay to fill KTP / NPWP / phone / address
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    setBusy(true); setNotice(null);
    try { await deleteDeclarationUser(id); setRows((prev) => prev.filter((r) => r.id !== id)); setNotice({ tone: 'err', text: 'Removed.' }); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Declaration users</div>}
      <div className="set-sec-sub">People who can sign the customs declaration (SP Declare / Surat Pernyataan). KTP, NPWP, phone and address change per person and fill the document when you pick a name.</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && rows.length === 0 && <div className="hint">No declaration users yet — add one below.</div>}
        {rows.map((r, i) => (
          <div key={r.id} className="set-row">
            <span className="set-decl-name">{r.name || '—'}</span>
            <div className="set-row-ctl">
              <button className="set-arrow" aria-label="Edit" onClick={() => openEdit(r)} disabled={busy}><PencilIcon /></button>
              <button className="set-arrow" aria-label="Move up" onClick={() => move(i, -1)} disabled={busy || i === 0}>▲</button>
              <button className="set-arrow" aria-label="Move down" onClick={() => move(i, 1)} disabled={busy || i === rows.length - 1}>▼</button>
              <button className="set-del" aria-label="Remove" onClick={() => remove(r.id)} disabled={busy}>✕</button>
            </div>
          </div>
        ))}
      </div>

      {addName !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">Add declaration user</div>
          <input type="text" placeholder="full name (e.g. Andrio Suroyo)" value={addName} autoFocus disabled={busy}
            onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddName(null)} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown btn-ico" onClick={() => setAddName('')} disabled={busy}><UserIcon />Add declaration user</button>
        </div>
      )}

      {/* PR280 — edit overlay: all five identity fields, each with its own header. */}
      {editing && (
        <div className="sc-modal-backdrop" onClick={editClose.requestClose}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit declaration user" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Edit declaration user</span>
              <button className="sc-modal-x" onClick={editClose.requestClose} disabled={busy} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="po-field">
                <label>Name</label>
                <input type="text" value={draft.name} placeholder="full name" disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="po-field">
                <label>Identity number (KTP)</label>
                <input type="text" inputMode="numeric" value={draft.ktp} placeholder="16-digit KTP" disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, ktp: e.target.value }))} />
              </div>
              <div className="po-field">
                <label>Tax number (NPWP)</label>
                <input type="text" value={draft.npwp} placeholder="NPWP" disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, npwp: e.target.value }))} />
              </div>
              <div className="po-field">
                <label>Phone number</label>
                <input type="text" inputMode="tel" value={draft.phone} placeholder="No. HP" disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
              </div>
              <div className="po-field">
                <label>Address (on KTP)</label>
                <textarea rows={3} value={draft.address} placeholder="Alamat sesuai KTP" disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))} />
              </div>
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={saveEdit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
          {editClose.confirm}
        </div>
      )}
    </Wrap>
  );
}
