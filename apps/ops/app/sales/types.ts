// Shared types for the Sales (order entry) module. Plain module (NO 'use server') so the actions
// file can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, incl. interfaces).

import type { Tier, NextTier } from '@jigzle/lib';

// ── Panel 1: customer search (normalized phone + name, case-insensitive contains) ──
export interface CustomerHit {
  id: number;
  name: string | null;
  phone: string | null;
  tier: Tier | null;
  lifetime_spend: number;
}

// ── Panel 1: loyalty readout for the selected customer ──
export interface LoyaltyReadout {
  tier: Tier | null;
  lifetime_spend: number;
  to_next_tier: NextTier | null;
}

// ── Panel 1: create-or-return customer (dedup on the normalized-phone unique index) ──
export interface NewCustomerInput {
  name: string;
  phone: string;
  channel?: string;
}

export interface NewAddressInput {
  recipient_name?: string;
  contact_phone?: string;
  raw_address: string;
  kota?: string;
  kode_pos?: string;
}

// ── Panel 2: SKU search via the shared search_skus RPC (PR23) — word-split over item_code +
// translate_name; available + on_the_way from the stock_snapshot matview (on_the_way drives PR24's
// readiness label; ignored by the current OrderEntry UI). ──
export interface SkuHit {
  item_code: string;
  name: string;
  available: number;
  on_the_way: number;
}

// ── Panel 5: save the order (atomic, via the create_order RPC) ──
export interface OrderLineInput {
  item_code: string;
  qty: number;
  unit_price_idr: number;
  item_link?: string | null;
  line_note?: string | null;
}

export interface OrderPaymentInput {
  amount_idr: number;
  method: string | null;
  note?: string | null;
}

export interface CreateOrderInput {
  customer_id: number | null;
  address_id: number;
  order_note?: string | null;
  lines: OrderLineInput[];
  payment: OrderPaymentInput | null;
}
