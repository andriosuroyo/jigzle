'use client';

// Shared presentational shell for the app's pre-submit confirm windows (PR28 §5). Renders the
// .sc-modal* chrome ONCE — darkened backdrop, centered frame, head (title + subtitle), scrollable
// body, footer (Back + Confirm). The two confirm windows — Stock-Check CloseConfirm and Inbound
// ReceiveConfirm — keep their OWN rows + decision state and pass them in as children; this component
// owns no decision logic. Extracted from the shell both previously duplicated (Andrio's redline:
// extraction, not a literal merge). No behavior change — same markup, same Back/Confirm wiring.
// (cancelLabel is a prop so each window keeps its exact Back wording — "…counting" vs "…scanning".)

import type { ReactNode } from 'react';

export default function ConfirmModal({
  title,
  subtitle,
  error,
  busy,
  confirmLabel,
  confirmDisabled,
  cancelLabel = '← Back',
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  error?: string | null;
  busy?: boolean;
  confirmLabel: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sc-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sc-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sc-modal-head">
          <div className="sc-modal-title">{title}</div>
          {subtitle != null && <div className="sc-modal-sub">{subtitle}</div>}
        </div>

        <div className="sc-modal-body">
          {children}
          {error && <div className="validation err" style={{ marginTop: 10 }}>{error}</div>}
        </div>

        <div className="sc-modal-foot">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className="btn-primary" onClick={onConfirm} disabled={busy || confirmDisabled}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
