import { redirect } from 'next/navigation';

// JZ-001 — History is now the 4th tab in the Orders pipeline window (no longer its own hub card). Keep
// /history as a redirect for muscle memory + old deep links.
export default function HistoryRedirect() {
  redirect('/orders?tab=history');
}
