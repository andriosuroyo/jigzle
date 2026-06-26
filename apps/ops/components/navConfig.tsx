import type { ReactNode } from 'react';

// Single source of truth for the primary nav: 7 items in 3 groups, each with a monochrome icon.
// Consumed by BOTH header layouts in AppHeader (desktop grouped bar + mobile slide-down drawer).
// Icons are inline SVGs drawn with `stroke="currentColor"` so they inherit the link text colour
// (white on the brown bar, brown wherever the text is brown) — never a separate hard-coded colour.

// `sub` is the one-line hub blurb (rendered on the landing-page cards, §10). Optional so the menu
// (AppHeader) — which ignores it — is unaffected.
export type NavItem = { key: string; href: string; label: string; icon: ReactNode; sub?: string };
export type NavGroup = { label: string; items: NavItem[] };

const svg = (children: ReactNode): ReactNode => (
  <svg
    className="nav-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

// Orders — bulleted list (the sales-order lifecycle overview board)
const iconOrders = svg(
  <>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </>
);

// Purchasing — receipt / document (the Purchase-Order / procurement board)
const iconOrder = svg(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <line x1="10" y1="9" x2="8" y2="9" />
  </>
);

// Inbound — tray arrow down (goods in)
const iconInbound = svg(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>
);

// Inventory — package / box
const iconInventory = svg(
  <>
    <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </>
);

// Catalog — open book (the reference / master list)
const iconCatalog = svg(
  <>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </>
);

// Stock Check — clipboard with a check (count / reconcile)
const iconStockCheck = svg(
  <>
    <path d="M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <polyline points="9 14 11 16 15 12" />
  </>
);

// Settings — gear (configurable pick-lists)
const iconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </>
);

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Sales & Purchasing',
    items: [
      // JZ-001: the four sell-side stages (New / Pending / Fulfill / Outbound) + History collapse into a
      // single Orders pipeline window. New is a button inside that window; History is its 4th tab.
      { key: 'orders', href: '/orders', label: 'Sales', icon: iconOrders, sub: 'The sell-side pipeline — Pending → Fulfill → Outbound, plus History; + new orders.' },
      { key: 'purchasing', href: '/purchasing', label: 'Purchasing', icon: iconOrder, sub: 'Enter & advance purchase orders; group them into shipments.' },
    ],
  },
  {
    label: 'Warehouse',
    items: [
      { key: 'inbound', href: '/inbound', label: 'Inbound', icon: iconInbound, sub: 'Check arrivals into stock — the only "+" side.' },
      { key: 'inventory', href: '/inventory', label: 'Inventory', icon: iconInventory, sub: 'Stock per SKU — on order, being shipped, in warehouse.' },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'catalog', href: '/catalog', label: 'Catalog', icon: iconCatalog, sub: 'Edit SKUs & barcodes; needs-review & shared-barcode cleanup.' },
      { key: 'stock-check', href: '/stock-check', label: 'Stock Check', icon: iconStockCheck, sub: 'Count the shelf (presence / scan) & true stock up with adjustments.' },
      { key: 'settings', href: '/settings', label: 'Settings', icon: iconSettings, sub: 'Configurable lists — payment, courier, box, inbound labels.' },
    ],
  },
];
