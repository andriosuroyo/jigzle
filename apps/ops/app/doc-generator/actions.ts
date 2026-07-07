'use server';

// Doc Generator server actions (PR202). Same auth posture as the rest of the app — the SSR supabase
// client (anon key + signed-in session), RLS via is_allowed_user(). Phase 1 (invoices) is read-only:
// it draws customers / customer_addresses / orders / order_lines / catalogue, plus sku-images for the
// item thumbnails. Nothing is written and no new tables are touched.

import { createSupabaseServerClient } from '@jigzle/db/server';
import { resolveSkuImages } from '@/app/images/actions';
import { getCustomers } from '@/app/customers/actions';
import type { InvoiceAddress, InvoiceCustomerData, InvoiceCustomerRow, InvoiceLine, InvoiceOrder } from './types';

// Lightweight customer picker list (id / name / phone), reusing the directory's paged loader.
export async function getInvoiceCustomers(): Promise<InvoiceCustomerRow[]> {
  const rows = await getCustomers();
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone }));
}

// catalogue name convention used everywhere: translate_name || original_name || self_code || code
type CatEmbed = { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
function skuName(cat: CatEmbed, fallback: string): string {
  return cat?.translate_name?.trim() || cat?.original_name?.trim() || cat?.self_code?.trim() || fallback;
}

// Everything the invoice tab needs for one customer: their saved addresses (for Send-to / Bill-to) and
// their orders with line items (item code, resolved name, qty, thumbnail). Cancelled lines/orders are
// dropped. Unit price is NOT returned — it is entered manually on the invoice.
export async function getInvoiceData(customerId: number): Promise<InvoiceCustomerData | null> {
  const supabase = createSupabaseServerClient();

  const { data: cust } = await supabase
    .from('customers')
    .select('customer_id,name,phone,phone_raw')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (!cust) return null;
  const c = cust as { customer_id: number; name: string | null; phone: string | null; phone_raw: string | null };

  const { data: addrs } = await supabase
    .from('customer_addresses')
    .select('address_id,address_label,recipient_name,contact_phone,raw_address')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  const addresses: InvoiceAddress[] = (addrs ?? []).map((a) => {
    const r = a as { address_id: number; address_label: string | null; recipient_name: string | null; contact_phone: string | null; raw_address: string | null };
    return {
      addressId: r.address_id,
      label: r.address_label,
      recipientName: r.recipient_name,
      contactPhone: r.contact_phone,
      rawAddress: r.raw_address,
    };
  });

  const { data: ords } = await supabase
    .from('orders')
    .select('sales_id,order_date,status,order_lines(line_id,item_code,item_code_raw,qty,is_cancelled,catalogue(original_name,translate_name,self_code))')
    .eq('customer_id', customerId)
    .order('order_date', { ascending: false });

  // PostgREST types a to-one embed as an array; accept either and normalize with catOf().
  type LineRow = { line_id: number; item_code: string | null; item_code_raw: string | null; qty: number | null; is_cancelled: boolean | null; catalogue: CatEmbed | CatEmbed[] };
  type OrderRow = { sales_id: string; order_date: string | null; status: string | null; order_lines: LineRow[] };
  const catOf = (c: CatEmbed | CatEmbed[]): CatEmbed => (Array.isArray(c) ? c[0] ?? null : c);

  const rawOrders = (ords ?? []) as unknown as OrderRow[];
  const orders: InvoiceOrder[] = [];
  const allCodes = new Set<string>();
  // remember which code each line was resolved with, so thumbnails attach to the right line
  const resolveByLine = new Map<number, string>();
  for (const o of rawOrders) {
    if (o.status === 'Cancelled') continue;
    const lines: InvoiceLine[] = [];
    for (const l of o.order_lines ?? []) {
      if (l.is_cancelled) continue;
      const code = (l.item_code_raw || l.item_code || '').trim();
      const resolveCode = (l.item_code || l.item_code_raw || '').trim();
      if (resolveCode) {
        allCodes.add(resolveCode);
        resolveByLine.set(l.line_id, resolveCode);
      }
      lines.push({
        lineId: l.line_id,
        orderId: o.sales_id,
        itemCode: code,
        name: skuName(catOf(l.catalogue), code || '(unnamed)'),
        qty: Number(l.qty) || 0,
        imageUrl: null, // filled after image resolve
      });
    }
    if (lines.length) orders.push({ orderId: o.sales_id, orderDate: o.order_date, lines });
  }

  // Resolve thumbnails in one batch; attach by the exact code each line was resolved with.
  const imgMap = await resolveSkuImages([...allCodes]);
  for (const o of orders) {
    for (const line of o.lines) {
      const rc = resolveByLine.get(line.lineId);
      line.imageUrl = (rc && imgMap[rc]?.displayUrl) || null;
    }
  }

  return {
    customerId: c.customer_id,
    name: c.name,
    phone: c.phone_raw || c.phone,
    addresses,
    orders,
  };
}
