'use client';

// Settings → Catalog → Brand logos (PR379). Sets brands.logo_url (0104) per brand — the image shown in
// Catalog → Browse in place of the generated monogram. Paste any reachable image URL; blank clears it
// (back to the monogram). Self-loads its list on mount; degrades to an empty list until 0104 is applied.

import { useEffect, useMemo, useState } from 'react';
import BrandAvatar from '@/components/BrandAvatar';
import { getBrandLogos, setBrandLogo, type BrandLogoRow } from '@/app/settings/actions';

export default function BrandLogoSettings({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<BrandLogoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({}); // prefix → in-progress url
  const [savingPfx, setSavingPfx] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getBrandLogos().then(setRows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.prefix.toLowerCase().includes(q) || (r.country ?? '').toLowerCase().includes(q));
  }, [rows, filter]);

  const valOf = (r: BrandLogoRow) => (r.prefix in edits ? edits[r.prefix] : (r.logo_url ?? ''));
  const dirty = (r: BrandLogoRow) => (r.prefix in edits) && edits[r.prefix].trim() !== (r.logo_url ?? '');

  async function save(r: BrandLogoRow) {
    const url = valOf(r).trim();
    setSavingPfx(r.prefix); setNotice(null);
    try {
      const res = await setBrandLogo(r.prefix, url);
      if (res.error) { setNotice({ tone: 'err', text: res.error }); return; }
      setRows((prev) => prev.map((x) => (x.prefix === r.prefix ? { ...x, logo_url: url || null } : x)));
      setEdits((e) => { const n = { ...e }; delete n[r.prefix]; return n; });
      setNotice({ tone: 'ok', text: `${r.name} logo ${url ? 'saved' : 'cleared'}.` });
    } catch (e) {
      setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally { setSavingPfx(null); }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? '' : 'set-sec'}>
      {!embedded && <div className="set-sec-title">Brand logos</div>}
      <div className="set-sec-sub">
        Give a brand a logo, shown in Catalog → Browse in place of the auto monogram. Paste a reachable
        image URL (Supabase Storage, a CDN, or the brand’s own site); leave it blank to keep the monogram.
        A link that won’t load falls back to the monogram too.
      </div>

      {notice && <div className={`validation ${notice.tone}`} style={{ margin: '8px 0' }}>{notice.text}</div>}

      <input className="field" style={{ margin: '8px 0' }} placeholder="Filter brands…" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="set-list">
        {loading && <div className="hint">Loading…</div>}
        {!loading && shown.length === 0 && <div className="hint">No brands match.</div>}
        {shown.map((r) => (
          <div key={r.prefix} className="set-row brand-logo-row">
            <BrandAvatar name={r.name} prefix={r.prefix} logoUrl={valOf(r).trim() || null} />
            <div className="brand-logo-main">
              <div className="brand-logo-name">{r.name} <span className="cat-tree-sub">{r.prefix}</span></div>
              <input
                type="url" inputMode="url" placeholder="https://… logo image URL"
                value={valOf(r)} disabled={savingPfx === r.prefix}
                onChange={(e) => setEdits((x) => ({ ...x, [r.prefix]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && dirty(r)) save(r); }}
              />
            </div>
            <button className="btn-primary brand-logo-save" onClick={() => save(r)} disabled={!dirty(r) || savingPfx === r.prefix}>Save</button>
          </div>
        ))}
      </div>
    </Wrap>
  );
}
