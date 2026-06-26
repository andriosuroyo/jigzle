import { redirect } from 'next/navigation';

// JZ-001 — Pending is now the default tab of the Sales pipeline window (/sales). Keep this route as a
// redirect for muscle memory + old deep links. The board lives in @/components/PendingBoard, mounted
// by the Sales shell.
export default function PendingRedirect() {
  redirect('/sales');
}
