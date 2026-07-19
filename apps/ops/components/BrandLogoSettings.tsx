'use client';

// Settings → Catalog → Brands (PR379 → standard-setting rewrite). Manages the `brands` table: a logo
// (uploaded image, via the shared IconCell), the immutable prefix (PK) + name, and an edit overlay for
// origin country + description. Add a brand via the overlay; delete is blocked while any SKU still uses
// it (catalogue.brand_prefix FK). Self-loads on mount; degrades to an empty list on an older schema.

import { useEffect, useMemo, useState } from 'react';
import IconCell from '@/components/IconCell';
import ConfirmModal from '@/components/ConfirmModal';
import TrashButton from '@/components/TrashButton';
import { TagIcon } from '@/components/AddIcons';
import { getBrandLogos, addBrand, updateBrand, deleteBrand, type BrandLogoRow } from '@/app/settings/actions';
import { useOverlayClose } from '@/components/useOverlayClose';

// pencil (Edit) — matches the detail-view edit glyph elsewhere.
const PencilIcon = () => (<svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);

type Draft = { name: string; country: string; description: string };
const blankAdd = { prefix: '', name: '', country: '', description: '' };

export default function BrandLogoSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<BrandLogoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [adding, setAdding] = useState<typeof blankAdd | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // prefix being edited
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<BrandLogoRow | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  useEffect(() => {
    getBrandLogos().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.prefix.toLowerCase().includes(q) || (r.country ?? '').toLowerCase().includes(q));
  }, [rows, filter]);

  const editRow = rows.find((r) => r.prefix === editing) ?? null;
  const editDirty = !!(editRow && draft) && (
    draft.name !== (editRow.name ?? '') ||
    draft.country !== (editRow.country ?? '') ||
    draft.description !== (editRow.description ?? '')
  );
  const addDirty = !!adding && (adding.prefix.trim() !== '' || adding.name.trim() !== '' || adding.country.trim() !== '' || adding.description.trim() !== '');
  const editClose = useOverlayClose({ open: editing !== null, onClose: () => { setEditing(null); setDraft(null); }, dirty: editDirty });
  const addClose = useOverlayClose({ open: adding !== null, onClose: () => setAdding(null), dirty: addDirty });

  async function saveLogo(prefix: string, logo: string | null) {
    setBusy(true); setNotice(null);
    try {
      const res = await updateBrand(prefix, { logo_url: logo });
      if (res.error) { setNotice({ tone: 'err', text: res.error }); return; }
      setRows((prev) => prev.map((r) => (r.prefix === prefix ? { ...r, logo_url: logo } : r)));
      setNotice({ tone: 'warn', text: 'Saved.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  function openEdit(r: BrandLogoRow) {
    setEditing(r.prefix);
    setDraft({ name: r.name ?? '', country: r.country ?? '', description: r.description ?? '' });
  }
  async function saveEdit() {
    if (editing == null || !draft) return;
    setBusy(true); setNotice(null);
    try {
      const res = await updateBrand(editing, { name: draft.name, country: draft.country, description: draft.description });
      if (res.error) { setNotice({ tone: 'err', text: res.error }); return; }
      setRows((prev) => prev.map((r) => (r.prefix === editing ? { ...r, name: draft.name.trim() || r.prefix, country: draft.country.trim() || null, description: draft.description.trim() || null } : r)));
      setEditing(null); setDraft(null);
      setNotice({ tone: 'warn', text: 'Saved.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function submitAdd() {
    if (!adding) return;
    const prefix = adding.prefix.trim().toUpperCase();
    if (!prefix) { setNotice({ tone: 'err', text: 'A brand prefix is required.' }); return; }
    if (rows.some((r) => r.prefix.toUpperCase() === prefix)) { setNotice({ tone: 'err', text: `Brand "${prefix}" already exists.` }); return; }
    setBusy(true); setNotice(null);
    try {
      const res = await addBrand({ prefix, name: adding.name, country: adding.country, description: adding.description });
      if (res.error || !res.row) { setNotice({ tone: 'err', text: res.error ?? 'Add failed.' }); return; }
      setRows((prev) => [...prev, res.row!].sort((a, b) => a.name.localeCompare(b.name)));
      setAdding(null);
      setNotice({ tone: 'ok', text: 'Added.' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true); setDelErr(null);
    try {
      const res = await deleteBrand(deleting.prefix);
      if (res.error) { setDelErr(res.error); return; }
      setRows((prev) => prev.filter((r) => r.prefix !== deleting.prefix));
      setDeleting(null);
      setNotice({ tone: 'err', text: 'Removed.' });
    } catch (e) { setDelErr(e instanceof Error ? e.message : 'Delete failed.'); } finally { setBusy(false); }
  }

  function sortAZ() { setRows((prev) => [...prev].sort((a, b) => a.name.localeCompare(b.name))); }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Brands</div>}
      <div className="set-sec-sub">
        Manage brands used across the Catalog. Upload a logo (shown in Catalog → Browse in place of the
        auto monogram), and set each brand’s origin country and description. Deleting a brand is blocked
        while any SKU still uses it.
      </div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <input className="field" style={{ margin: '8px 0' }} placeholder="Filter brands…" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && shown.length === 0 && <div className="hint">{rows.length ? 'No brands match.' : 'No brands yet — add one below.'}</div>}
        {shown.map((r) => (
          <div key={r.prefix} className="set-row brand-row">
            <IconCell value={r.logo_url} disabled={busy} onChange={(v) => saveLogo(r.prefix, v)} title="Logo" />
            <div className="brand-row-main">
              <span className="brand-row-name">{r.name}</span>
              <span className="brand-row-prefix">{r.prefix}</span>
            </div>
            <div className="set-row-ctl">
              <button className="btn-edit" aria-label="Edit" title="Edit" onClick={() => openEdit(r)} disabled={busy}><PencilIcon /></button>
              <TrashButton onClick={() => { setDelErr(null); setDeleting(r); }} disabled={busy} ariaLabel={`Delete ${r.name}`} />
            </div>
          </div>
        ))}
      </div>

      <div className="set-toolbar">
        <button className="btn-brown btn-ico" onClick={() => setAdding({ ...blankAdd })} disabled={busy}><TagIcon />Add brand</button>
        <button className="btn-secondary" onClick={sortAZ} disabled={busy || rows.length < 2}>Sort A–Z</button>
      </div>

      {/* edit overlay — origin country + description (name too); prefix is the immutable identity */}
      {editRow && draft && (
        <div className="sc-modal-backdrop" onClick={editClose.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Edit brand" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{editRow.name} <span className="brand-row-prefix">{editRow.prefix}</span></span>
              <button className="sc-modal-x" onClick={editClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="po-field"><label>Brand name</label>
                <input type="text" value={draft.name} disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
              <div className="po-field"><label>Origin country</label>
                <input type="text" placeholder="e.g. China" value={draft.country} disabled={busy} onChange={(e) => setDraft({ ...draft, country: e.target.value })} /></div>
              <div className="po-field"><label>Description</label>
                <textarea rows={3} placeholder="Notes about the brand" value={draft.description} disabled={busy} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
              <div className="confirm-actions" style={{ marginTop: 8 }}>
                <button className="btn-primary" onClick={saveEdit} disabled={busy || !editDirty}>Save changes</button>
                <button className="btn-secondary" onClick={editClose.requestClose} disabled={busy}>Cancel</button>
              </div>
            </div>
          </div>
          {editClose.confirm}
        </div>
      )}

      {/* add overlay — prefix (identity) + name, plus optional country / description */}
      {adding && (
        <div className="sc-modal-backdrop" onClick={addClose.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Add brand" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Add brand</span>
              <button className="sc-modal-x" onClick={addClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="po-field"><label>Prefix<span className="req" aria-hidden="true">*</span></label>
                <input type="text" autoFocus placeholder="e.g. 3DW" value={adding.prefix} disabled={busy}
                  onChange={(e) => setAdding({ ...adding, prefix: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }} /></div>
              <div className="po-field"><label>Brand name</label>
                <input type="text" placeholder="e.g. 3D Wooden" value={adding.name} disabled={busy} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
              <div className="po-field"><label>Origin country</label>
                <input type="text" placeholder="e.g. China" value={adding.country} disabled={busy} onChange={(e) => setAdding({ ...adding, country: e.target.value })} /></div>
              <div className="po-field"><label>Description</label>
                <textarea rows={3} placeholder="Notes about the brand" value={adding.description} disabled={busy} onChange={(e) => setAdding({ ...adding, description: e.target.value })} /></div>
              <div className="confirm-actions" style={{ marginTop: 8 }}>
                <button className="btn-primary" onClick={submitAdd} disabled={busy || !adding.prefix.trim()}>Add brand</button>
                <button className="btn-secondary" onClick={addClose.requestClose} disabled={busy}>Cancel</button>
              </div>
            </div>
          </div>
          {addClose.confirm}
        </div>
      )}

      {deleting && (
        <ConfirmModal
          title={`Delete ${deleting.name}?`}
          subtitle={`Brand ${deleting.prefix}`}
          error={delErr}
          busy={busy}
          confirmLabel="Delete brand"
          cancelLabel="Cancel"
          danger
          onConfirm={confirmDelete}
          onCancel={() => { if (!busy) { setDeleting(null); setDelErr(null); } }}
        >
          <div className="hint">This removes the brand from the list. It’s blocked if any SKU still uses it.</div>
        </ConfirmModal>
      )}
    </Wrap>
  );
}
