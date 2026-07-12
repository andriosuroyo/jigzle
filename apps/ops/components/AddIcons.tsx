// PR236 — semantic icons for the app's secondary "add" buttons (brown, affirmative-secondary). The bare
// leading "+" is reserved for the top-level "New order" / "New item" create entries; every OTHER add
// button carries a meaningful icon instead. Pair with the `btn-ico` class for the icon+label layout.
const P = { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

// a note / notepad (Add note)
export const NoteIcon = () => (<svg {...P}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="14 3 14 9 20 9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>);
// a box (Add item)
export const PackageIcon = () => (<svg {...P}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>);
// a person (Add customer / declaration user)
export const UserIcon = () => (<svg {...P}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
// a map pin (Add address)
export const MapPinIcon = () => (<svg {...P}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>);
// vertical bars (Add barcode)
export const BarcodeIcon = () => (<svg {...P}><line x1="4" y1="6" x2="4" y2="18" /><line x1="8" y1="6" x2="8" y2="18" /><line x1="12" y1="6" x2="12" y2="18" /><line x1="16" y1="6" x2="16" y2="18" /><line x1="20" y1="6" x2="20" y2="18" /></svg>);
// a storefront (Add supplier)
export const StoreIcon = () => (<svg {...P}><path d="M3 21h18" /><path d="M5 21V9h14v12" /><path d="M4 9l1.4-5h13.2L20 9z" /></svg>);
// a truck (Add forwarder / export courier / local & consolidator courier)
export const TruckIcon = () => (<svg {...P}><rect x="1" y="4" width="14" height="12" rx="1" /><path d="M15 8h4l3 3v5h-7z" /><circle cx="6" cy="18.5" r="2" /><circle cx="18.5" cy="18.5" r="2" /></svg>);
// a warehouse (Add consolidator — the collection/consolidation node)
export const WarehouseIcon = () => (<svg {...P}><path d="M22 8.35V20a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z" /><path d="M6 18h12" /><path d="M6 14h12" /><path d="M6 10h12" /></svg>);
// a plane (Add shipper courier — the international carrier)
export const PlaneIcon = () => (<svg {...P}><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></svg>);
// a plus-in-circle for generic "add a row" buttons (Settings sections)
export const PlusCircleIcon = () => (<svg {...P}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>);

// a tag — for the search-alias "add" button (PR344)
export const TagIcon = () => (<svg {...P}><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>);
