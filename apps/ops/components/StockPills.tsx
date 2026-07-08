'use client';

// PR150 — the To-buy pipeline figures as icon+qty pills: factory = at forwarder, plane = shipped
// (on the way), box = in the warehouse (the same box glyph Sales uses for item readiness). A zero
// pill fades so non-zero stock reads at a glance.

function FactoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21V9l6 4V9l6 4V4h6v17H3z" />
    </svg>
  );
}

function PlaneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 13.5 3 11l18-7-7 18-2.5-7.5z" />
      <path d="M10.5 13.5 21 4" />
    </svg>
  );
}

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  );
}

// PR239 — `combined` renders the three figures inside ONE pill (a single border/background with three
// icon+number cells) instead of three separate pills, so the quickview cards stay compact.
export default function StockPills({ wf, otw, avail, combined }: { wf: number; otw: number; avail: number; combined?: boolean }) {
  if (combined) {
    const cell = (n: number, icon: React.ReactNode, label: string) => (
      <span className={`stock-cell ${n > 0 ? '' : 'zero'}`} title={label} aria-label={`${label}: ${n}`}>
        {icon}
        {n}
      </span>
    );
    return (
      <span className="stock-pill stock-pill-combined">
        {cell(wf, <FactoryIcon />, 'At forwarder')}
        {cell(otw, <PlaneIcon />, 'Shipped')}
        {cell(avail, <BoxIcon />, 'Warehouse')}
      </span>
    );
  }
  const pill = (n: number, icon: React.ReactNode, label: string) => (
    <span className={`stock-pill ${n > 0 ? '' : 'zero'}`} title={label} aria-label={`${label}: ${n}`}>
      {icon}
      {n}
    </span>
  );
  return (
    <span className="stock-pills">
      {pill(wf, <FactoryIcon />, 'At forwarder')}
      {pill(otw, <PlaneIcon />, 'Shipped')}
      {pill(avail, <BoxIcon />, 'Warehouse')}
    </span>
  );
}
