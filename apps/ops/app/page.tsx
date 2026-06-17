import Link from 'next/link';

export const dynamic = 'force-dynamic';

// Ops home — nav hub. Modules land here as they ship (Sales, Fulfill, then Outbound…).
export default function Home() {
  return (
    <div className="ops">
      <header className="app-header">
        <div className="logo">J</div>
        <div className="title">Jigzle Ops</div>
      </header>
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
      </div>
    </div>
  );
}
