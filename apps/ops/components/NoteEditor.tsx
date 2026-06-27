'use client';

// Per-line shipment-note editor (0035). A single text input wired to a <datalist> of the Settings-
// managed common notes — so the operator gets a dropdown of reusable notes AND free text in one field.
// Saves on blur (and on Enter) when the value changed; empty clears the note. Used in Pending/Fulfill;
// Outbound shows the note read-only and History locks it.

import { useId, useState } from 'react';
import { setLineNote } from '@/app/pending/actions';
import type { CommonNote } from '@/app/settings/types';

export default function NoteEditor({
  lineId,
  value,
  commonNotes,
  onSaved,
}: {
  lineId: string;
  value: string | null;
  commonNotes: CommonNote[];
  onSaved?: (note: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const listId = useId();

  async function commit() {
    const next = draft.trim();
    if (next === (value ?? '').trim()) return; // unchanged → no write
    setSaving(true);
    setSaved(false);
    try {
      await setLineNote(lineId, next || null);
      onSaved?.(next || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch {
      // revert the draft to the last known good value on failure
      setDraft(value ?? '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="note-edit">
      <span className="note-edit-tag" aria-hidden="true">✎</span>
      <input
        type="text"
        list={listId}
        className="note-edit-input"
        placeholder="Add a note…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        disabled={saving}
      />
      <datalist id={listId}>
        {commonNotes.map((n) => <option key={n.id} value={n.label} />)}
      </datalist>
      {saved && <span className="note-edit-ok" aria-hidden="true">✓</span>}
    </div>
  );
}
