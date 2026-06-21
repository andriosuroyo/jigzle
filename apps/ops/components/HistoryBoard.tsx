'use client';

import AppHeader from '@/components/AppHeader';

// PR-B Stage 1 skeleton — the read-only all-orders History screen (spec §4) is built in Stage 6.
export default function HistoryBoard({ userEmail }: { userEmail: string }) {
  return (
    <div className="ops">
      <AppHeader active="history" userEmail={userEmail} />
      <div className="fd-empty" style={{ padding: 24 }}>History — coming in this PR.</div>
    </div>
  );
}
