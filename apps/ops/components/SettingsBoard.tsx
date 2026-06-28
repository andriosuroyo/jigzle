'use client';

import { useState } from 'react';
import AppHeader from '@/components/AppHeader';
import SupplierSettings from '@/components/SupplierSettings';
import type { Supplier } from '@jigzle/db/types';
import {
  addSetting,
  deleteSetting,
  reorderSetting,
  updateSetting,
} from '@/app/settings/actions';
import type {
  SettingPayload,
  SettingPatch,
  SettingRow,
  SettingsData,
  SettingsKind,
} from '@/app/settings/types';

// ── per-list column config ──
type Col = { key: string; label: string; type: 'text' | 'number'; nullable?: boolean; grow?: boolean };

type SectionDef = {
  kind: SettingsKind;
  title: string;
  sub: string;
  cols: Col[];
  sortKey: string; // the field the A–Z button orders by
  autoLabel?: { from: string[]; target: string }; // courier: label follows "{courier} {speed}" while unset
  blank: SettingPayload; // payload for "Add row" (NOT NULL text cols seeded as '')
};

const SECTIONS: SectionDef[] = [
  {
    kind: 'payment',
    title: 'Payment methods',
    sub: 'Shown in the Sales payment-method picker.',
    cols: [{ key: 'label', label: 'Label', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'courier',
    title: 'Courier services',
    sub: 'Stored as courier + speed; shown as one dropdown of labels. Label auto-fills from courier + speed until you edit it.',
    cols: [
      { key: 'courier', label: 'Courier', type: 'text', grow: true },
      { key: 'speed', label: 'Speed', type: 'text', nullable: true },
      { key: 'label', label: 'Label', type: 'text', grow: true },
    ],
    sortKey: 'label',
    autoLabel: { from: ['courier', 'speed'], target: 'label' },
    blank: { courier: '', label: '' },
  },
  {
    kind: 'box',
    title: 'Box presets',
    sub: 'Volumetric box sizes (cm). Filler 1s are placeholders — drop in real dims.',
    cols: [
      { key: 'code', label: 'Code', type: 'text', grow: true },
      { key: 'dim_p', label: 'P (cm)', type: 'number', nullable: true },
      { key: 'dim_l', label: 'L (cm)', type: 'number', nullable: true },
      { key: 'dim_t', label: 'T (cm)', type: 'number', nullable: true },
    ],
    sortKey: 'code',
    blank: { code: '' },
  },
  {
    kind: 'inbound_labels',
    title: 'Inbound labels',
    sub: 'Shown in the Inbound per-line label picker.',
    cols: [{ key: 'label', label: 'Label', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'common_note',
    title: 'Common notes',
    sub: 'Reusable shipment notes (gift wrap, free gift, …) offered in the Pending/Fulfill note picker.',
    cols: [{ key: 'label', label: 'Note', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
];

const val = (row: SettingRow, key: string): unknown => (row as unknown as Record<string, unknown>)[key];

// parse a raw input string for a column → the value to persist (undefined = skip: invalid number, or
// a blank required-text field we must not write over a real value).
function parseCol(col: Col, raw: string): string | number | null | undefined {
  if (col.type === 'number') {
    const s = raw.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }
  const s = raw.trim();
  if (s === '') return col.nullable ? null : undefined; // required text: don't persist a blank
  return s;
}

// "{courier} {speed}".trim(), collapsing whitespace.
function suggestLabel(d: Record<string, string>): string {
  return `${(d.courier ?? '').trim()} ${(d.speed ?? '').trim()}`.replace(/\s+/g, ' ').trim();
}

export default function SettingsBoard({ initial, suppliers, userEmail }: { initial: SettingsData; suppliers: Supplier[]; userEmail: string }) {
  const [lists, setLists] = useState<Record<SettingsKind, SettingRow[]>>({
    payment: initial.paymentMethods,
    courier: initial.courierServices,
    box: initial.boxPresets,
    inbound_labels: initial.inboundLabels,
    common_note: initial.commonNotes,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function setRows(kind: SettingsKind, updater: (rows: SettingRow[]) => SettingRow[]) {
    setLists((prev) => ({ ...prev, [kind]: updater(prev[kind]) }));
  }
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.');
  const ok = (msg: string) => { setError(null); setSuccess(msg); };

  async function saveRow(kind: SettingsKind, id: number, patch: SettingPatch) {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSetting(kind, id, patch);
      setRows(kind, (rows) => rows.map((r) => (r.id === id ? updated : r)));
      ok('Saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function persistOrder(kind: SettingsKind, rows: SettingRow[]) {
    setBusy(true);
    setError(null);
    try {
      await reorderSetting(kind, rows.map((r) => r.id));
      ok('Order saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function move(kind: SettingsKind, index: number, dir: -1 | 1) {
    const rows = lists[kind];
    const j = index + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[index], next[j]] = [next[j], next[index]];
    setRows(kind, () => next);
    void persistOrder(kind, next);
  }

  function sortAZ(kind: SettingsKind, sortKey: string) {
    const next = lists[kind]
      .slice()
      .sort((a, b) =>
        String(val(a, sortKey) ?? '').localeCompare(String(val(b, sortKey) ?? ''), undefined, { sensitivity: 'base' })
      );
    setRows(kind, () => next);
    void persistOrder(kind, next);
  }

  async function add(kind: SettingsKind, blank: SettingPayload) {
    setBusy(true);
    setError(null);
    try {
      const row = await addSetting(kind, blank);
      setRows(kind, (rows) => [...rows, row]);
      ok('Added a row.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: SettingsKind, id: number) {
    setBusy(true);
    setError(null);
    try {
      await deleteSetting(kind, id);
      setRows(kind, (rows) => rows.filter((r) => r.id !== id));
      ok('Removed.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="settings" userEmail={userEmail} />

      <div className="set-wrap">
        {error && <div className="validation err">{error}</div>}
        {success && <div className="validation ok">{success}</div>}

        {SECTIONS.map((sec) => {
          const rows = lists[sec.kind];
          return (
            <section className="set-sec" key={sec.kind}>
              <div className="set-sec-title">{sec.title}</div>
              <div className="set-sec-sub">{sec.sub}</div>

              <div className="set-list">
                {rows.length === 0 && <div className="hint">No rows yet — add one below.</div>}
                {rows.map((row, i) => (
                  <SettingRowEditor
                    key={row.id}
                    sec={sec}
                    row={row}
                    first={i === 0}
                    last={i === rows.length - 1}
                    busy={busy}
                    onSave={(patch) => saveRow(sec.kind, row.id, patch)}
                    onToggleActive={(active) => saveRow(sec.kind, row.id, { is_active: active })}
                    onMove={(dir) => move(sec.kind, i, dir)}
                    onRemove={() => remove(sec.kind, row.id)}
                  />
                ))}
              </div>

              <div className="set-toolbar">
                <button className="btn-secondary" onClick={() => add(sec.kind, sec.blank)} disabled={busy}>
                  + Add row
                </button>
                <button className="btn-secondary" onClick={() => sortAZ(sec.kind, sec.sortKey)} disabled={busy || rows.length < 2}>
                  Sort A–Z
                </button>
              </div>
            </section>
          );
        })}

        <SupplierSettings initial={suppliers} />
      </div>
    </div>
  );
}

// ── one editable row: text/number fields (saved on blur), active toggle, up/down, remove ──
function SettingRowEditor({
  sec,
  row,
  first,
  last,
  busy,
  onSave,
  onToggleActive,
  onMove,
  onRemove,
}: {
  sec: SectionDef;
  row: SettingRow;
  first: boolean;
  last: boolean;
  busy: boolean;
  onSave: (patch: SettingPatch) => void;
  onToggleActive: (active: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const initDraft = (): Record<string, string> => {
    const d: Record<string, string> = {};
    for (const c of sec.cols) {
      const v = val(row, c.key);
      d[c.key] = v == null ? '' : String(v);
    }
    return d;
  };
  const [draft, setDraft] = useState<Record<string, string>>(initDraft);
  // courier label follows courier+speed only while it has not been hand-edited (i.e. still equals the
  // derived value). Seeds ('TIKI ONS', 'J&T') start auto; a custom label sticks.
  const [labelAuto, setLabelAuto] = useState<boolean>(
    () => !sec.autoLabel || draft[sec.autoLabel.target] === suggestLabel(draft)
  );

  function onChange(key: string, value: string) {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // while the label is still auto-derived, keep it following courier/speed.
      if (sec.autoLabel && sec.autoLabel.from.includes(key) && labelAuto) {
        next[sec.autoLabel.target] = suggestLabel(next);
      }
      return next;
    });
    // a manual label edit disarms auto-follow (re-arms if cleared or typed back to the suggestion).
    if (sec.autoLabel && key === sec.autoLabel.target) {
      const sug = suggestLabel({ ...draft, [key]: value });
      setLabelAuto(value.trim() === '' || value === sug);
    }
  }

  // on blur: diff the whole row's draft against the server row, persist all changed editable columns
  // in one update (so an auto-filled label rides along with its courier/speed edit).
  function onBlur() {
    const patch: SettingPatch = {};
    for (const c of sec.cols) {
      const v = parseCol(c, draft[c.key] ?? '');
      if (v === undefined) continue; // invalid number → skip
      const cur = val(row, c.key) ?? null;
      const same = (v === null && cur === null) || String(v ?? '') === String(cur ?? '');
      if (!same) patch[c.key] = v;
    }
    if (Object.keys(patch).length) onSave(patch);
  }

  const active = row.is_active;
  return (
    <div className={`set-row${active ? '' : ' inactive'}`}>
      <div className="set-fields">
        {sec.cols.map((c) => (
          <div className={`set-f${c.grow ? ' grow' : ''}${c.type === 'number' ? ' num' : ''}`} key={c.key}>
            <label>{c.label}</label>
            <input
              type={c.type === 'number' ? 'number' : 'text'}
              inputMode={c.type === 'number' ? 'decimal' : undefined}
              step={c.type === 'number' ? 'any' : undefined}
              value={draft[c.key] ?? ''}
              placeholder={c.label}
              onChange={(e) => onChange(c.key, e.target.value)}
              onBlur={onBlur}
              disabled={busy}
            />
          </div>
        ))}
      </div>

      <div className="set-row-ctl">
        <div className="set-arrows">
          <button className="set-arrow" aria-label="Move up" onClick={() => onMove(-1)} disabled={busy || first}>▲</button>
          <button className="set-arrow" aria-label="Move down" onClick={() => onMove(1)} disabled={busy || last}>▼</button>
        </div>
        <label className="set-active">
          <input type="checkbox" checked={active} onChange={(e) => onToggleActive(e.target.checked)} disabled={busy} />
          Active
        </label>
        <button className="btn-link" onClick={onRemove} disabled={busy}>Remove</button>
      </div>
    </div>
  );
}
