import { redirect } from 'next/navigation';

// JZ-001 — History is now the 3rd tab in the Sales pipeline window (/sales). Keep /history as a
// redirect for muscle memory + old deep links.
export default function HistoryRedirect() {
  redirect('/sales?tab=history');
}
