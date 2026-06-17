import Link from 'next/link';
import { createSupabaseServerClient } from '@jigzle/db/server';
import AppHeader from '@/components/AppHeader';

export const dynamic = 'force-dynamic';

// Ops home — nav hub. Modules land here as they ship (Sales, Fulfill, then Outbound…).
export default async function Home() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="ops">
      <AppHeader userEmail={user?.email || ''} />
      <div className="hub">
        <Link href="/procurement" className="hub-card">
          <div className="hub-card-title">Procurement</div>
          <div className="hub-card-sub">Enter & advance purchase orders; group them into shipments.</div>
        </Link>
        <Link href="/sales/new" className="hub-card">
          <div className="hub-card-title">Sales</div>
          <div className="hub-card-sub">Take a new order — customer, items, payment.</div>
        </Link>
        <Link href="/fulfill" className="hub-card">
          <div className="hub-card-title">Fulfill</div>
          <div className="hub-card-sub">Commit stock for paid orders waiting to go out.</div>
        </Link>
        <Link href="/outbound" className="hub-card">
          <div className="hub-card-title">Outbound</div>
          <div className="hub-card-sub">Box, weigh, and ship fulfilled orders.</div>
        </Link>
        <Link href="/receiving" className="hub-card">
          <div className="hub-card-title">Receiving</div>
          <div className="hub-card-sub">Check arrivals into stock — the only "+" side.</div>
        </Link>
        <Link href="/inventory" className="hub-card">
          <div className="hub-card-title">Inventory</div>
          <div className="hub-card-sub">Stock per SKU — on order, being shipped, in warehouse.</div>
        </Link>
        <Link href="/catalogue" className="hub-card">
          <div className="hub-card-title">Catalogue</div>
          <div className="hub-card-sub">Edit SKUs & barcodes; needs-review &amp; shared-barcode cleanup.</div>
        </Link>
      </div>
    </div>
  );
}
