import { redirect } from 'next/navigation';

// JZ-001 — the Sales pipeline window moved to /sales. Keep /orders as a redirect for muscle memory +
// old deep links, preserving the ?tab= / ?order= query so links land on the right tab/order.
export default function OrdersRedirect({
  searchParams,
}: {
  searchParams?: { tab?: string; order?: string };
}) {
  const p = new URLSearchParams();
  if (searchParams?.tab) p.set('tab', searchParams.tab);
  if (searchParams?.order) p.set('order', searchParams.order);
  const qs = p.toString();
  redirect(qs ? `/sales?${qs}` : '/sales');
}
