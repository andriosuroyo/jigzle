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
// a truck (Add forwarder / export courier)
export const TruckIcon = () => (<svg {...P}><rect x="1" y="4" width="14" height="12" rx="1" /><path d="M15 8h4l3 3v5h-7z" /><circle cx="6" cy="18.5" r="2" /><circle cx="18.5" cy="18.5" r="2" /></svg>);
// a plus-in-circle for generic "add a row" buttons (Settings sections)
export const PlusCircleIcon = () => (<svg {...P}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>);
