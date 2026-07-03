'use client';

// PR148 — the shared delete-order confirm overlay. Every stage (Pending / Fulfill / History) fronts
// the delete_order RPC with this window instead of a bare window.confirm: the stage passes its own
// consequence lines, and the footer makes the destructive step an explicit second tap. The deletion
// itself is snapshotted server-side into order_delete_log (0054).

import ConfirmModal from '@/components/ConfirmModal';

export default function DeleteOrderConfirm({
  salesId,
  lines,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  salesId: string;
  lines: string[]; // stage-specific consequence bullets
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      title={`Delete ${salesId}?`}
      subtitle="This permanently removes the order. A snapshot is kept in the delete log."
      error={error}
      busy={busy}
      confirmLabel={busy ? 'Deleting…' : 'Delete order'}
      cancelLabel="← Back"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul className="del-confirm-list">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </ConfirmModal>
  );
}
