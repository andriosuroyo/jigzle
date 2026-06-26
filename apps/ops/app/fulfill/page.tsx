import { redirect } from 'next/navigation';

// JZ-001 — Fulfill is now a tab in the Sales pipeline window (/sales). Keep /fulfill as a redirect
// (muscle memory + the ?order= deep-link), forwarding into the matching tab.
export default function FulfillRedirect({ searchParams }: { searchParams?: { order?: string } }) {
  const order = searchParams?.order;
  redirect(order ? `/sales?tab=fulfill&order=${encodeURIComponent(order)}` : '/sales?tab=fulfill');
}
