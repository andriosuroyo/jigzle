'use client';

// Settings → Forwarders (PR123). Manages the `forwarders` table the Purchasing → To-ship group panel
// reads from. Each forwarder is a flag (picked from a country dropdown — stores the emoji + derives the
// country), an immutable prefix (the ship_id prefix / PK: SUB, MTE, LGB, IMA, …) and an optional name
// (e.g. "Superbuy", "Mentari Timur Ekspress"). Rows reorder with ▲▼ and delete (soft) with ✕, mirroring
// Settings → Suppliers. The prefix can't be edited after creation — it's the join key for shipments.

import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { TruckIcon } from '@/components/AddIcons';
import { addForwarder, deleteForwarder, reorderForwarders, updateForwarder, renameConsolidatorPrefix, getConsolidatorOpenShipmentCount } from '@/app/purchasing/actions';
import { uploadSettingIcon } from '@/app/settings/actions';
import type { Forwarder } from '@jigzle/db/types';
import FlagSelect from '@/components/FlagSelect';

// a stored logo is an uploaded image when it's a URL/path; otherwise it's a short emoji/text.
const isLogoUrl = (s: string | null | undefined): boolean => !!s && /^(https?:\/\/|\/)/.test(s);

// PR276 — compact logo cell: tap to set an emoji or upload an image (mirrors the generic settings icon).
function LogoCell({ value, onChange, disabled = false }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState(value && !isLogoUrl(value) ? value : '');
  const [uploading, setUploading] = useState(false);
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { url } = await uploadSettingIcon(fd);
      onChange(url);
      setOpen(false);
    } catch { /* surfaced elsewhere */ } finally { setUploading(false); }
  }
  return (
    <div className="set-ico-wrap">
      <button type="button" className="set-ico" onClick={() => setOpen(true)} disabled={disabled} aria-label="Set logo">
        {value ? (
          isLogoUrl(value)
            // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN logo, off the data path
            ? <img className="set-ico-img" src={value} alt="" />
            : <span className="set-ico-emoji">{value}</span>
        ) : <span className="set-ico-add">+</span>}
      </button>
      {open && (
        <div className="sc-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Set logo" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row"><span className="sc-modal-title">Logo</span><button className="sc-modal-x" onClick={() => setOpen(false)} aria-label="Close">×</button></div>
            <div className="sc-modal-body">
              <div className="po-field">
                <label>Emoji</label>
                <input type="text" value={emoji} placeholder="🛒" onChange={(e) => setEmoji(e.target.value)} />
              </div>
              <div className="sc-modal-foot" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button className="btn-primary" onClick={() => { onChange(emoji.trim() || null); setOpen(false); }}>Save emoji</button>
                <label className="btn-secondary" style={{ cursor: 'pointer' }}>
                  {uploading ? 'Uploading…' : 'Upload image'}
                  <input type="file" accept="image/*" hidden onChange={pick} disabled={uploading} />
                </label>
                {value && <button className="btn-secondary danger" onClick={() => { setEmoji(''); onChange(null); setOpen(false); }}>Remove</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ForwarderSettings({ initial, embedded = false }: { initial: Forwarder[]; embedded?: boolean }) {
  const [rows, setRows] = useState<Forwarder[]>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [adding, setAdding] = useState<{ prefix: string; name: string; flag: string; country: string; logo: string | null } | null>(null);
  // PR276 — the prefix-rename dialog (rewrites every owned ship_id, so it's an explicit confirm).
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  // PR278 — the delete confirm, with the consolidator's live open-shipment count.
  const [deleting, setDeleting] = useState<{ prefix: string; open: number } | null>(null);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  async function save(prefix: string, patch: Partial<Pick<Forwarder, 'name' | 'flag' | 'country' | 'logo'>>) {
    setBusy(true); setNotice(null);
    try {
      const updated = await updateForwarder(prefix, patch);
      setRows((prev) => prev.map((r) => (r.prefix === prefix ? updated : r)));
      note('warn', 'Saved.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  // PR276 — commit a prefix rename (cascades to ship_ids server-side); update the local row on success.
  async function commitRename() {
    if (!renaming) return;
    const from = renaming.from;
    const to = renaming.to.trim().toUpperCase();
    if (!to) { note('err', 'A new prefix is required.'); return; }
    if (to === from) { setRenaming(null); return; }
    if (rows.some((r) => r.prefix.toUpperCase() === to)) { note('err', `${to} already exists.`); return; }
    setBusy(true); setNotice(null);
    try {
      const { error, touched } = await renameConsolidatorPrefix(from, to);
      if (error) { note('err', error); return; }
      setRows((prev) => prev.map((r) => (r.prefix === from ? { ...r, prefix: to } : r)));
      setRenaming(null);
      note('ok', `Renamed ${from} → ${to} · ${touched} ship id${touched === 1 ? '' : 's'} updated.`);
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
      const fwd = await addForwarder({ prefix, name: adding.name.trim() || null, flag: adding.flag || null, country: adding.country || null, logo: adding.logo });
      setRows((prev) => (prev.some((r) => r.prefix === fwd.prefix) ? prev.map((r) => (r.prefix === fwd.prefix ? fwd : r)) : [...prev, fwd]));
      setAdding(null);
      note('ok', 'Added a consolidator.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  // PR278 — open the delete confirm, first counting the consolidator's OPEN shipments so the dialog can
  // warn (historical/completed shipments stay resolvable regardless — this is a soft delete).
  async function requestRemove(prefix: string) {
    setBusy(true); setNotice(null);
    try {
      const open = await getConsolidatorOpenShipmentCount(prefix);
      setDeleting({ prefix, open });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function commitRemove() {
    if (!deleting) return;
    const prefix = deleting.prefix;
    setBusy(true); setNotice(null);
    try {
      await deleteForwarder(prefix);
      setRows((prev) => prev.filter((r) => r.prefix !== prefix));
      setDeleting(null);
      note('err', 'Removed.');
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Consolidators</div>}
      <div className="set-sec-sub">Consolidators (Superbuy / SUB, LetsGoBuy / LGB, …), picked in Purchasing → Ship → Create shipment. The prefix is the ship-id series (SUB, LGB, …) — picking a consolidator there pre-fills its last ship id (editable). The flag sets the country.</div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <div className="set-list">
        {rows.length > 0 && (
          <div className="set-colhead set-colhead-sup" aria-hidden>
            <div className="sup-flag-cell">Flag</div>
            <div className="sup-flag-cell">Logo</div>
            <div className="set-fields"><div className="set-f fwd-prefix-cell">Prefix</div><div className="set-f grow">Consolidator name</div></div>
            <div className="set-colhead-ctl" />
          </div>
        )}
        {rows.length === 0 && <div className="hint">No consolidators yet — add one below.</div>}
        {rows.map((f, i) => (
          <ForwarderRow
            key={f.prefix}
            fwd={f}
            busy={busy}
            first={i === 0}
            last={i === rows.length - 1}
            onSave={(patch) => save(f.prefix, patch)}
            onRequestRename={() => setRenaming({ from: f.prefix, to: f.prefix })}
            onMove={(dir) => move(i, dir)}
            onRemove={() => requestRemove(f.prefix)}
          />
        ))}
      </div>

      {adding ? (
        <div className="subform" style={{ marginTop: 8 }}>
          <div className="subform-label">Add consolidator</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="sup-flag-cell">
              <FlagSelect value={adding.flag || null} onChange={({ flag, country }) => setAdding((a) => (a ? { ...a, flag, country } : a))} />
            </div>
            <LogoCell value={adding.logo} onChange={(logo) => setAdding((a) => (a ? { ...a, logo } : a))} disabled={busy} />
            <input type="text" placeholder="prefix (e.g. SUB)" value={adding.prefix} onChange={(e) => setAdding((a) => (a ? { ...a, prefix: e.target.value.toUpperCase() } : a))} style={{ width: 120 }} />
            <input type="text" placeholder="name (e.g. “Superbuy”)" value={adding.name} onChange={(e) => setAdding((a) => (a ? { ...a, name: e.target.value } : a))} style={{ flex: 1 }} />
          </div>
          <div className="subform-actions">
            <button className="btn-link" onClick={() => setAdding(null)} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submitAdd} disabled={busy}>add</button>
          </div>
        </div>
      ) : (
        <div className="set-toolbar">
          <button className="btn-brown btn-ico" onClick={() => setAdding({ prefix: '', name: '', flag: '', country: '', logo: null })} disabled={busy}><TruckIcon />Add consolidator</button>
          <button className="btn-secondary" onClick={sortAZ} disabled={busy || rows.length < 2}>Sort A–Z</button>
        </div>
      )}

      {/* PR276 — prefix rename confirm: rewrites every owned ship_id (SUB 192 → SBY 192). */}
      {renaming && (
        <div className="sc-modal-backdrop" onClick={() => !busy && setRenaming(null)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Rename prefix" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row"><span className="sc-modal-title">Rename {renaming.from}</span><button className="sc-modal-x" onClick={() => setRenaming(null)} disabled={busy} aria-label="Close">×</button></div>
            <div className="sc-modal-body">
              <div className="po-field">
                <label>New prefix</label>
                <input type="text" autoFocus value={renaming.to} onChange={(e) => setRenaming((r) => (r ? { ...r, to: e.target.value.toUpperCase() } : r))} placeholder="e.g. SBY" disabled={busy} />
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                This rewrites <b>{renaming.from}</b> and <b>every ship id that uses it</b> (e.g. <code>{renaming.from} 192</code> → <code>{renaming.to.trim() || '…'} 192</code>) across all shipments, POs, receipts and boxes. It can’t be auto-undone.
              </div>
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => setRenaming(null)} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={commitRename} disabled={busy || !renaming.to.trim() || renaming.to.trim().toUpperCase() === renaming.from}>{busy ? 'Renaming…' : 'Rename'}</button>
            </div>
          </div>
        </div>
      )}

      {/* PR278 — delete confirm, warning if the consolidator still has open shipments (soft delete). */}
      {deleting && (
        <div className="sc-modal-backdrop" onClick={() => !busy && setDeleting(null)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Remove consolidator" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row"><span className="sc-modal-title">Remove {deleting.prefix}?</span><button className="sc-modal-x" onClick={() => setDeleting(null)} disabled={busy} aria-label="Close">×</button></div>
            <div className="sc-modal-body">
              {deleting.open > 0 ? (
                <div className="validation warn">
                  <b>{deleting.prefix}</b> still has <b>{deleting.open} open shipment{deleting.open === 1 ? '' : 's'}</b>. They stay resolvable in History, but you won’t be able to group new items under {deleting.prefix} once it’s removed.
                </div>
              ) : (
                <div className="hint">No open shipments — safe to remove.</div>
              )}
              <div className="hint" style={{ marginTop: 8 }}>This is a soft delete: {deleting.prefix} just drops from the picker + this list. All historical shipments keep their ship ids and still resolve, and re-adding {deleting.prefix} later restores it.</div>
            </div>
            <div className="sc-modal-foot">
              <button className="btn-secondary" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
              <button className="btn-primary danger" onClick={commitRemove} disabled={busy}>{busy ? 'Removing…' : 'Remove'}</button>
            </div>
          </div>
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
  onRequestRename,
  onMove,
  onRemove,
}: {
  fwd: Forwarder;
  busy: boolean;
  first: boolean;
  last: boolean;
  onSave: (patch: Partial<Pick<Forwarder, 'name' | 'flag' | 'country' | 'logo'>>) => void;
  onRequestRename: () => void;
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
      <div className="sup-flag-cell">
        <LogoCell value={fwd.logo} onChange={(logo) => onSave({ logo })} disabled={busy} />
      </div>
      <div className="set-fields">
        <div className="set-f fwd-prefix-cell">
          {/* PR276 — prefix is renameable (cascades to ship_ids); tap to open the confirm dialog. */}
          <button type="button" className="fwd-prefix fwd-prefix-btn" title="Rename this prefix (rewrites its ship ids)" onClick={onRequestRename} disabled={busy}>{fwd.prefix}</button>
        </div>
        <div className="set-f grow">
          <input type="text" value={name} placeholder="consolidator name" onChange={(e) => setName(e.target.value)} onBlur={(e) => blurName(e.target.value)} disabled={busy} />
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
