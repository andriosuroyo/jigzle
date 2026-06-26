import { redirect } from 'next/navigation';

// JZ-001 — the sell-side flow now lives in the Orders pipeline window. /sales lands on it (Pending
// tab). The create-order form is still at /sales/new (reached via the window's "+ New order" button).
export default function SalesRedirect() {
  redirect('/orders');
}
