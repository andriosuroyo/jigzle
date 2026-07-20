'use client';

// Settings → Clover Royalty → Entities (PR392). Manages royalty_entities (Voila Arts, Mentol Art) and,
// per entity, the piece-count → Royalty (Rp) schedule in royalty_rate_rows. The list shows one line per
// entity; Edit opens an overlay with the entity name + a two-column rate table (Piece count · Royalty).
// Mirrors DeclarationUserSettings' list+overlay shape. Self-loads on mount.

import { useState, useEffect } from 'react';
import { UserIcon } from '@/components/AddIcons';
import {
  getRoyaltyEntities, addRoyaltyEntity, renameRoyaltyEntity, deleteRoyaltyEntity,
  getRoyaltyRates, upsertRoyaltyRate, deleteRoyaltyRate,
} from '@/app/royalty/actions';
import type { RoyaltyEntity, RoyaltyRateRow } from '@/app/royalty/types';
import { fmtRp } from '@jigzle/lib';
import { useOverlayClose } from '@/components/useOverlayClose';

const PencilIcon = () => (<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);

export default function RoyaltyEntitySettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<RoyaltyEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [addName, setAddName] = useState<string | null>(null);

  // edit overlay state
  const [editing, setEditing] = useState<RoyaltyEntity | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [rates, setRates] = useState<RoyaltyRateRow[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [newPieces, setNewPieces] = useState('');
  const [newRoyalty, setNewRoyalty] = useState('');

  useEffect(() => { getRoyaltyEntities().then(setRows).catch(() => {}).finally(() => setLoading(false)); }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const editClose = useOverlayClose({ open: editing !== null, onClose: () => { if (!busy) setEditing(null); }, dirty: false });

  async function openEdit(r: RoyaltyEntity) {
    setNotice(null);
    setEditing(r);
    setNameDraft(r.name);
    setRatesLoading(true);
    setRates(await getRoyaltyRates(r.name).catch(() => []));
    setRatesLoading(false);
  }

  async function submitAdd() {
    const name = (addName ?? '').trim();
    if (!name) { setNotice({ tone: 'err', text: 'A name is required.' }); return; }
    setBusy(true); setNotice(null);
    try {
      const { row, error } = await addRoyaltyEntity(name);
      if (error || !row) { setNotice({ tone: 'err', text: error ?? 'Could not add.' }); return; }
      setRows((prev) => [...prev, row]);
      setAddName(null);
      void openEdit(row);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function saveName() {
    if (!editing) return;
    const nm = nameDraft.trim();
    if (nm === editing.name) return;
    setBusy(true); setNotice(null);
    try {
      const { error } = await renameRoyaltyEntity(editing.id, editing.name, nm);
      if (error) { setNotice({ tone: 'err', text: error }); return; }
      setRows((prev) => prev.map((r) => (r.id === editing.id ? { ...r, name: nm } : r)));
      setEditing((e) => (e ? { ...e, name: nm } : e));
      setRates(await getRoyaltyRates(nm).catch(() => []));
      setNotice({ tone: 'warn', text: 'Renamed everywhere (rates, ledger & SKU artist).' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function remove(r: RoyaltyEntity) {
    setBusy(true); setNotice(null);
    try {
      const { error } = await deleteRoyaltyEntity(r.id, r.name);
      if (error) { setNotice({ tone: 'err', text: error }); return; }
      setRows((prev) => prev.filter((x) => x.id !== r.id));
      setNotice({ tone: 'err', text: 'Removed.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function reloadRates() { if (editing) setRates(await getRoyaltyRates(editing.name).catch(() => [])); }

  async function commitRate(pieces: number, royaltyIdr: number) {
    if (!editing) return;
    setBusy(true); setNotice(null);
    try {
      const { error } = await upsertRoyaltyRate(editing.name, pieces, royaltyIdr);
      if (error) { setNotice({ tone: 'err', text: error }); return; }
      await reloadRates();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function addRate() {
    const p = parseInt(newPieces, 10);
    const r = parseInt(newRoyalty.replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(p) || p <= 0) { setNotice({ tone: 'err', text: 'Enter a piece count.' }); return; }
    if (!Number.isFinite(r) || r < 0) { setNotice({ tone: 'err', text: 'Enter a royalty amount.' }); return; }
    await commitRate(p, r);
    setNewPieces(''); setNewRoyalty('');
  }

  async function removeRate(id: number) {
    setBusy(true); setNotice(null);
    try { await deleteRoyaltyRate(id); await reloadRates(); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Clover Royalty entities</div>}
      <div className="set-sec-sub">The studios Clover pays royalties to (matched to a SKU’s Artist). Edit an entity to set its piece-count → royalty (Rp) schedule; new paid-and-sent sales accrue at these rates.</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && rows.length === 0 && <div className="hint">No entities yet — add one below.</div>}
        {rows.map((r) => (
          <div key={r.id} className="set-row">
            <span className="set-decl-name">{r.name}</span>
            <div className="set-row-ctl">
              <button className="set-arrow" aria-label="Edit" onClick={() => openEdit(r)} disabled={busy}><PencilIcon /></button>
              <button className="set-del" aria-label="Remove" onClick={() => remove(r)} disabled={busy}>✕</button>
            </div>
          </div>
        ))}
      </div>

      {addName !== null ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">Add entity</div>
          <input type="text" placeholder="studio name (e.g. Voila Arts)" value={addName} autoFocus disabled={busy}
            onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} />
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAddName(null)} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown btn-ico" onClick={() => setAddName('')} disabled={busy}><UserIcon />Add entity</button>
        </div>
      )}

      {editing && (
        <div className="sc-modal-backdrop" onClick={editClose.requestClose}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Edit royalty entity" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Edit entity</span>
              <button className="sc-modal-x" onClick={editClose.requestClose} disabled={busy} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="po-field">
                <label>Name</label>
                <input type="text" value={nameDraft} disabled={busy}
                  onChange={(e) => setNameDraft(e.target.value)} onBlur={saveName}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }} />
              </div>

              <div className="fd-section-head" style={{ marginTop: 6 }}>Royalty schedule</div>
              <div className="roy-rate-head"><span>Piece count</span><span>Royalty (Rp)</span><span /></div>
              {ratesLoading ? <div className="hint">Loading…</div> : rates.length === 0 ? (
                <div className="hint">No rates yet — add a piece-count band below.</div>
              ) : (
                <div className="roy-rate-list">
                  {rates.map((rt) => (
                    <div key={rt.id} className="roy-rate-row">
                      <span className="roy-rate-pieces">×{rt.pieces.toLocaleString('en-US')}</span>
                      <span className="roy-rate-amt">{fmtRp(rt.royalty_idr)}</span>
                      <button className="set-del" aria-label="Remove rate" onClick={() => removeRate(rt.id)} disabled={busy}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              <div className="roy-rate-add">
                <input type="number" inputMode="numeric" placeholder="pieces" value={newPieces} disabled={busy}
                  onChange={(e) => setNewPieces(e.target.value)} />
                <input type="number" inputMode="numeric" placeholder="Rp" value={newRoyalty} disabled={busy}
                  onChange={(e) => setNewRoyalty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addRate(); }} />
                <button className="btn-primary" onClick={addRate} disabled={busy}>Add</button>
              </div>
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => setEditing(null)} disabled={busy}>Close</button>
            </div>
          </div>
          {editClose.confirm}
        </div>
      )}
    </Wrap>
  );
}
