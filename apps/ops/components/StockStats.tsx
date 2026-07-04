'use client';

// PR156 — the Inventory stat icons, extracted so other screens (Sales item search) speak the same
// visual language: On order (incoming cart) · Shipped (truck) · Warehouse (box). A zero fades via
// the existing .inv-stat.zero rule.

export const IconOnOrder = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2l1.5 3M18 2l-1.5 3M3 6h18l-1.6 8.5a2 2 0 0 1-2 1.6H8.1" /><circle cx="9" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" />
  </svg>
);
export const IconShipped = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 5h13v11H1zM14 8h4l3 3v5h-7" /><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="18" r="1.6" />
  </svg>
);
export const IconWarehouse = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 21V8l9-5 9 5v13M3 21h18M9 21v-6h6v6" />
  </svg>
);

export default function StockStats({ pending, onTheWay, warehouse }: { pending: number; onTheWay: number; warehouse: number }) {
  return (
    <span className="stock-stats">
      <span className={`inv-stat ${pending ? '' : 'zero'}`} title="On order"><IconOnOrder />{pending}</span>
      <span className={`inv-stat ${onTheWay ? '' : 'zero'}`} title="Shipped"><IconShipped />{onTheWay}</span>
      <span className={`inv-stat ${warehouse ? '' : 'zero'}`} title="Warehouse"><IconWarehouse />{warehouse}</span>
    </span>
  );
}
