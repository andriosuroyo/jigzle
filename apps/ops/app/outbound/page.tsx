import { redirect } from 'next/navigation';

// JZ-001 — Outbound is now a tab in the Orders pipeline window. Keep /outbound as a redirect (muscle
// memory + the ?order= deep-link), forwarding into the matching tab.
export default function OutboundRedirect({ searchParams }: { searchParams?: { order?: string } }) {
  const order = searchParams?.order;
  redirect(order ? `/orders?tab=outbound&order=${encodeURIComponent(order)}` : '/orders?tab=outbound');
}
