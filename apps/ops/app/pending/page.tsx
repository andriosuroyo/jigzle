import { redirect } from 'next/navigation';

// JZ-001 — Pending is now the default tab of the Orders pipeline window. Keep this route as a redirect
// for muscle memory + old deep links. The board itself lives in @/components/PendingBoard, mounted by
// the Orders shell.
export default function PendingRedirect() {
  redirect('/orders');
}
