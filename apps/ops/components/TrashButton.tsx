'use client';

// PR150 — the standard delete affordance: a red button with a trashcan icon (replaces the muted ×).

export default function TrashButton({
  onClick,
  disabled,
  ariaLabel = 'Delete',
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button type="button" className={`btn-trash ${className ?? ''}`} onClick={onClick} disabled={disabled} aria-label={ariaLabel} title={ariaLabel}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}
