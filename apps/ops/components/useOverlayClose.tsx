'use client';

// PR307 — shared overlay-close behavior, applied to every .sc-modal overlay in the app.
//  • Pressing Esc requests a close (same path as clicking the backdrop or the × button).
//  • If the overlay has unsaved edits (dirty), the close is routed through a styled "Discard unsaved
//    changes?" confirm (reusing ConfirmModal) instead of closing immediately; a read-only / auto-saving
//    overlay passes no `dirty` and just closes.
//
// Usage (call once per overlay, at the component top level):
//   const { requestClose, confirm } = useOverlayClose({ open, onClose, dirty });
//   … <div className="sc-modal-backdrop" onClick={requestClose}> … × onClick={requestClose} … {confirm}
//
// `active`/`open` gates the Esc listener so a closed overlay doesn't grab the key. When several overlays
// can be open in one component, call the hook once per overlay with its own open/onClose/dirty.

import { useCallback, useEffect, useState } from 'react';
import ConfirmModal from '@/components/ConfirmModal';

// Esc-only close for overlays with nothing unsaved (delete confirms, read-only detail, auto-saving
// forms). `open` gates the listener. The backdrop/× already close on click; this just adds the key.
export function useEscToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export function useOverlayClose({
  open,
  onClose,
  dirty = false,
}: {
  open: boolean;
  onClose: () => void;
  dirty?: boolean;
}): { requestClose: () => void; confirm: React.ReactNode } {
  const [asking, setAsking] = useState(false);

  // close on our own terms whenever the overlay is dismissed externally, so `asking` never lingers
  useEffect(() => { if (!open && asking) setAsking(false); }, [open, asking]);

  const requestClose = useCallback(() => {
    if (dirty) setAsking(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // if the discard prompt is showing, Esc dismisses THAT (keep editing) rather than the overlay
      if (asking) { setAsking(false); return; }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, asking, requestClose]);

  // The discard dialog is usually rendered inside the parent overlay's backdrop; wrap it so a click on
  // ITS backdrop (dismiss) doesn't bubble up and re-fire the parent backdrop's onClick.
  const confirm = asking ? (
    <div onClick={(e) => e.stopPropagation()}>
      <ConfirmModal
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => { setAsking(false); onClose(); }}
        onCancel={() => setAsking(false)}
      >
        <div>You have unsaved changes. Close without saving them?</div>
      </ConfirmModal>
    </div>
  ) : null;

  return { requestClose, confirm };
}
