import { redirect } from 'next/navigation';

// PR171 — Stock Count is now a mode inside Inventory (the standalone Stock Check nav entry was retired).
// Keep the old route working: redirect any bookmarked / cached-PWA /stock-check link to /inventory.
export default function StockCheckPage() {
  redirect('/inventory');
}
