'use client';

// Settings → Purchasing → Declaration users (PR205). Manages settings_declaration_users — the identity
// pick-list for Doc Generator → SP Declare (Surat Pernyataan). Each person carries KTP, NPWP, phone and
// a per-person address (the address on the declaration changes with the signer). Self-loads on mount.

import { useEffect, useState } from 'react';
import { addDeclarationUser, deleteDeclarationUser, getDeclarationUsers, reorderDeclarationUsers, updateDeclarationUser } from '@/app/settings/actions';
import type { DeclarationUser } from '@/app/settings/types';

export default function DeclarationUserSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<DeclarationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addName, setAddName] = useState<string | null>(null);

  useEffect(() => {
    getDeclarationUsers().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });

  async function patch(id: number, p: Partial<DeclarationUser>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateDeclarationUser(id, p);
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
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
      setNotice({ tone: 'ok', text: 'Added.' });
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
          <div key={r.id} className="set-row exc-row">
            <div className="exc-main">
              <input className="exc-label" type="text" defaultValue={r.name} placeholder="full name" disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.name) patch(r.id, { name: v }); }} />
              <div className="set-row-ctl">
                <button className="set-arrow" aria-label="Move up" onClick={() => move(i, -1)} disabled={busy || i === 0}>▲</button>
                <button className="set-arrow" aria-label="Move down" onClick={() => move(i, 1)} disabled={busy || i === rows.length - 1}>▼</button>
                <button className="set-del" aria-label="Remove" onClick={() => remove(r.id)} disabled={busy}>✕</button>
              </div>
            </div>
            <div className="exc-addr">
              <input type="text" placeholder="Nomor KTP" defaultValue={r.ktp ?? ''} disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.ktp ?? null)) patch(r.id, { ktp: v }); }} />
              <input type="text" placeholder="NPWP" defaultValue={r.npwp ?? ''} disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.npwp ?? null)) patch(r.id, { npwp: v }); }} />
              <input type="text" placeholder="No. HP / Email" defaultValue={r.phone ?? ''} disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.phone ?? null)) patch(r.id, { phone: v }); }} />
              <textarea placeholder="Alamat (address)" rows={2} defaultValue={r.address ?? ''} disabled={busy}
                onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (r.address ?? null)) patch(r.id, { address: v }); }} />
            </div>
          </div>
        ))}
      </div>

      {addName !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">+ add declaration user</div>
          <input type="text" placeholder="full name (e.g. Andrio Suroyo)" value={addName} autoFocus disabled={busy}
            onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddName(null)} disabled={busy}>cancel</button>
            <button className="btn-secondary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown" onClick={() => setAddName('')} disabled={busy}>+ Add declaration user</button>
        </div>
      )}
    </Wrap>
  );
}
