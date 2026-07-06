'use server';

// PR196 — at-a-glance work-queue counts for the home hub cards (Sales / Purchasing / Outbound).
// Reuses the SAME loaders the boards use, so the numbers always agree with what each screen shows.
// Fetched CLIENT-side (lazy) after the hub renders, so the landing stays instant. Everything degrades
// to zeros on error — a count is a nicety, never a blocker.

import { getPending } from '@/app/pending/actions';
import { getPlannedItems, getPreorders } from '@/app/purchasing/actions';
import { getShipQueue } from '@/app/outbound/actions';

export interface HubCounts {
  sales: { toOrder: number; onTheWay: number; ready: number }; // pending orders by readiness dot
  purchasing: { manual: number; fromSales: number };           // To-buy: Planned (manual) vs Preorder (sales)
  outbound: { readyToShip: number };                            // ready-to-ship queue length
}

export async function getHubCounts(): Promise<HubCounts> {
  const [pending, planned, preorders, shipQueue] = await Promise.all([
    getPending().catch(() => []),
    getPlannedItems().catch(() => []),
    getPreorders().catch(() => []),
    getShipQueue().catch(() => []),
  ]);

  // Sales: bucket each pending order by its worst-line dot (red = to order, yellow = on the way, green = ready).
  let toOrder = 0, onTheWay = 0, ready = 0;
  for (const o of pending) {
    if (o.dot === 'red') toOrder++;
    else if (o.dot === 'yellow') onTheWay++;
    else ready++;
  }

  return {
    sales: { toOrder, onTheWay, ready },
    purchasing: { manual: planned.length, fromSales: preorders.length },
    outbound: { readyToShip: shipQueue.length },
  };
}
