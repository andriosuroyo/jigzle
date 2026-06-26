import { redirect } from 'next/navigation';

// JZ-001 — Fulfill is now a tab in the Orders pipeline window. Keep /fulfill as a redirect (muscle
// memory + the ?order= deep-link from elsewhere), forwarding into the matching tab.
export default function FulfillRedirect({ searchParams }: { searchParams?: { order?: string } }) {
  const order = searchParams?.order;
  redirect(order ? `/orders?tab=fulfill&order=${encodeURIComponent(order)}` : '/orders?tab=fulfill');
}
