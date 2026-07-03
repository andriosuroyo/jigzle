'use client';

// PR146 — the dual status circles on a sales quickview row: one box-icon circle for item readiness
// (red = any line to order, yellow = any on the way, green = all ready) and one $-icon circle for
// payment (red = unpaid, yellow = partial/DP, green = paid). Two same-sized glyphs read faster than
// the old mixed dot + pill, and the pair keeps item state and payment state visibly orthogonal.

export type CircleTone = 'red' | 'yellow' | 'green' | 'grey';

// payment_status string ('Paid' / 'Partial' / 'Unpaid' / …) → circle tone
export function payTone(status: string | null | undefined): CircleTone {
  const s = (status ?? '').toLowerCase();
  if (s === 'paid') return 'green';
  if (s === 'partial' || s === 'dp') return 'yellow';
  if (s === 'unpaid') return 'red';
  return 'grey';
}

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  );
}

export default function StatusCircles({ box, pay }: { box: CircleTone; pay: CircleTone }) {
  return (
    <span className="stat-circles">
      <span className={`stat-circle ${box}`} title="Item readiness" aria-label={`Items: ${box}`}>
        <BoxIcon />
      </span>
      <span className={`stat-circle ${pay}`} title="Payment" aria-label={`Payment: ${pay}`}>
        <span className="stat-circle-dollar">$</span>
      </span>
    </span>
  );
}
