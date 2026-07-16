'use client';

// SP Declare tab (PR205). Pick a declaration user (fills name / address / KTP / NPWP / phone from the
// Settings list) and enter the shipment tracking. Recipient, the lump-sum reason and the signing city
// are constant; the sign date is today.

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { pdf } from '@react-pdf/renderer';
import { getDeclarationUsers } from '@/app/settings/actions';
import type { DeclarationUser } from '@/app/settings/types';
import SpDeclareDoc from './SpDeclareDoc';

const PDFViewer = dynamic(() => import('@react-pdf/renderer').then((m) => m.PDFViewer), { ssr: false });

const box: React.CSSProperties = { border: '1px solid #d8d8d6', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 4 };
const inp: React.CSSProperties = { padding: '6px 8px', border: '1px solid #cfcfcd', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', width: '100%' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function todayLong(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export default function SpDeclareTab() {
  const [users, setUsers] = useState<DeclarationUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [tracking, setTracking] = useState('');
  const [dateStr] = useState(todayLong());
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    getDeclarationUsers().then(setUsers).catch(() => setUsers([])).finally(() => setLoaded(true));
  }, []);

  const user = useMemo(() => users.find((u) => u.id === userId) ?? null, [users, userId]);
  const ready = !!user;

  const docEl = (
    <SpDeclareDoc
      name={user?.name ?? ''}
      address={user?.address ?? ''}
      ktp={user?.ktp ?? ''}
      npwp={user?.npwp ?? ''}
      phone={user?.phone ?? ''}
      tracking={tracking}
      dateStr={dateStr}
    />
  );

  async function download() {
    setDownloading(true);
    try {
      const blob = await pdf(docEl).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `SP-Declare-${(user?.name ?? 'doc').replace(/[\\/:*?"<>|\s]/g, '_')}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 440px) 1fr', gap: 16, padding: 16, alignItems: 'start', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <div>
        <div style={box}>
          <label style={lbl}>Declaration user</label>
          <select style={inp} value={userId ?? ''} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— pick a person —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {loaded && users.length === 0 && (
            <div style={{ fontSize: 12, color: '#a00', marginTop: 6 }}>No declaration users yet — add them in <b>Settings → Purchasing → Declaration users</b> (needs migration 0068).</div>
          )}
          {user && (
            <div style={{ fontSize: 11, color: '#777', marginTop: 8, lineHeight: 1.5 }}>
              KTP: {user.ktp || <span style={{ color: '#a00' }}>— set in Settings</span>}<br />
              NPWP: {user.npwp || <span style={{ color: '#a00' }}>—</span>}<br />
              HP: {user.phone || <span style={{ color: '#a00' }}>—</span>}<br />
              Alamat: {user.address || <span style={{ color: '#a00' }}>— set in Settings</span>}
            </div>
          )}
        </div>

        <div style={box}>
          <label style={lbl}>Shipment tracking (nomor kiriman)</label>
          <input style={inp} value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. 1ZHV27120417582900" />
          <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Sign date is today: <b>{dateStr}</b>. Recipient (KPPBC) and the lump-sum reason are fixed.</div>
        </div>
      </div>

      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Preview</div>
          <button type="button" onClick={download} disabled={!ready || downloading}
            style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 6, border: 'none', background: ready ? '#724F33' : '#bbb', color: '#fff', fontWeight: 700, cursor: ready ? 'pointer' : 'default' }}>
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
        <div style={{ height: 820, border: '1px solid #d8d8d6', borderRadius: 8, overflow: 'hidden', background: '#f4f4f2' }}>
          {ready ? <PDFViewer width="100%" height="100%" showToolbar={false}>{docEl}</PDFViewer> : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14, textAlign: 'center', padding: 20 }}>Pick a declaration user to preview.</div>
          )}
        </div>
      </div>
    </div>
  );
}
