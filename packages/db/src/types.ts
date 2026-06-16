export type Currency = {
  code: string;
  name: string;
  rate_to_idr: number;
  is_base: boolean;
  updated_at: string;
};

export type ShippingMethod = {
  id: string;
  display: string;
  source_country: string;
  source_currency: string;
  rate_per_kg: number;
  rate_currency: string;
  warehouse_fee: number;
  tax_included: boolean;
  active: boolean;
  sort_order: number;
  notes: string;
};

export type SavedCalculation = {
  id: string;
  user_id: string;
  created_at: string;
  sku: string;
  method_id: string;
  method_display: string;
  source_country: string;
  source_currency: string;
  rate_currency: string;
  shipping_rate: number;
  warehouse_fee: number;
  tax_included: boolean;
  fx_source: number;
  fx_rate_ship: number;
  tax_rate: number;
  purchase_price: number;
  local_shipping: number;
  real_weight_g: number;
  box_p: number;
  box_l: number;
  box_t: number;
  coefficient: number;
  marketplace_active: boolean;
  marketplace_rate: number;
  item_cost_idr: number;
  shipping_cost_idr: number;
  import_tax_idr: number;
  marketplace_fee_idr: number;
  total_cost_idr: number;
  rec_sale_price: number;
  low_margin_idr: number;
};

export type UserPrefs = {
  user_id: string;
  method_id: string;
  tax_rate: number;
  coefficient: number;
  marketplace_active: boolean;
  marketplace_rate: number;
  updated_at: string;
};

// ── Phase-1 operations (sales order entry, J2.1) ──────────────────────────────
// Columns mirror the live tables: 0004_customers, 0005_sales (+ 0012 unit_price_idr
// / 'Partial'), 0003_catalogue (region dropped by 0010), and the 0009 stock_check
// view. Money is full IDR (bigint → number). Nullable columns are `| null`.

export type OrderStatus = 'Need payment' | 'Need send' | 'Complete' | 'Cancelled';
export type PaymentStatus = 'Paid' | 'Unpaid' | 'Partial' | 'Cancel';
export type PaymentType = 'DP' | 'Full' | 'Settlement';

export type Customer = {
  customer_id: number;
  name: string | null;
  phone: string | null;        // normalized (62… form)
  phone_raw: string | null;
  channel: string | null;
  channel_raw: string | null;
  ig_handle: string | null;
  created_at: string;
};

export type CustomerAddress = {
  address_id: number;
  customer_id: number;
  address_label: string | null;
  raw_address: string | null;
  recipient_name: string | null;
  contact_phone: string | null;
  street: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  kota: string | null;
  provinsi: string | null;
  negara: string | null;
  kode_pos: string | null;
  created_at: string;
};

export type Order = {
  sales_id: string;
  customer_id: number | null;
  customer_ref: string | null;
  address_id: number | null;
  order_date: string | null;
  status: OrderStatus | null;
  sales_total_idr: number | null;     // full IDR
  payment_method: string | null;
  payment_status: PaymentStatus | null;
  order_note: string | null;
  created_at: string;
};

export type OrderLine = {
  line_id: string;
  sales_id: string;
  item_code: string | null;
  item_code_raw: string | null;
  qty: number;
  unit_price_idr: number | null;      // full IDR (0012)
  item_link: string | null;
  line_note: string | null;
  courier: string | null;
  courier_tracking: string | null;
  fulfilled_at: string | null;        // stock cut #1 — NULL at order entry
  shipped_at: string | null;          // stock cut #2 — NULL at order entry
  is_cancelled: boolean;
  address_id: number | null;
  created_at: string;
};

export type Payment = {
  payment_id: number;
  sales_id: string;
  amount_idr: number;                 // full IDR
  type: PaymentType | null;
  method: string | null;
  paid_date: string | null;
  note: string | null;
  created_at: string;
};

export type Catalogue = {
  item_code: string;
  brand_prefix: string | null;
  self_code: string | null;
  original_name: string | null;
  translate_name: string | null;
  description: string | null;
  product_type: string | null;
  sub_type: string | null;
  piece_count: string | null;
  piece_count_n: number | null;
  piece_type: string | null;
  piece_size: string | null;
  size_p: number | null;
  size_l: number | null;
  size_t: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  real_weight: number | null;
  material: string | null;
  effect: string | null;
  image_type: string | null;
  artist: string | null;
  tags: string | null;
  article_number: string | null;
  release_date: string | null;
  release_year: number | null;
  release_month: number | null;
  theme: string | null;
  location: string | null;
  image: string | null;
  has_image: boolean;
  created_at: string;
  updated_at: string;
};

// One row per catalogue SKU from the live stock_check view (0009).
export type StockRow = {
  item_code: string;
  available: number;
  physical: number;
  reserved: number;
  on_hold: number;
  pending: number;
  on_the_way: number;
  last_receive: string | null;
};

// ── Fulfill module (Sales pipeline step 4) ────────────────────────────────────
// holds (0005): a physical hold-rack reservation; released_at NULL = active.
export type Hold = {
  hold_id: number;
  item_code: string;
  qty: number;
  customer_id: number | null;
  note: string | null;
  created_at: string;
  released_at: string | null;
};

// One row in the fulfill worklist: a 'Need send' order with unfulfilled lines, plus a
// readiness badge derived from stock_check.available.
export type FulfillQueueRow = {
  sales_id: string;
  order_date: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_status: PaymentStatus | null;
  line_count: number;          // unfulfilled, non-cancelled lines
  short_count: number;         // of those, how many have available < qty
  ready: boolean;              // short_count === 0
};

// One unfulfilled line in the fulfill detail pane, with its live available stock.
export type FulfillLine = {
  line_id: string;
  item_code: string | null;
  name: string;
  qty: number;
  available: number;           // stock_check.available for item_code (0 when unmatched/null)
};

// ── Outbound (Ship) module (Sales pipeline step 5) ────────────────────────────
// outbound_shipments (0008): one row per shipped SKU. 0014 adds the sales_id /
// order_line_id / send_id link columns (NULL on the 5,712 legacy rows).
export type OutboundShipment = {
  shipment_id: number;
  customer_id: number | null;
  customer_ref: string | null;
  ship_date: string | null;
  recipient_name: string | null;
  item_code: string | null;
  item_code_raw: string | null;
  qty: number;
  address: string | null;
  courier: string | null;
  weight_gram: number | null;
  processed: boolean | null;
  created_at: string;
  sales_id: string | null;        // 0014
  order_line_id: string | null;   // 0014
  send_id: string | null;         // 0014 — 'SND-YYMM-####' dispatch group
};

// boxes (0008): per-box volumetric model. 0014 adds send_id (new boxes group by it).
export type Box = {
  box_id: number;
  shipment_id: number | null;
  real_weight: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  bill_by_volume: boolean;
  vol_weight: number | null;          // ceil(p)·ceil(l)·ceil(t)/6000 (server-computed)
  chargeable_weight: number | null;   // max(real_weight, vol_weight) (server-computed)
  created_at: string;
  send_id: string | null;             // 0014
};

// One row in the ready-to-ship worklist: an order with fulfilled-but-unshipped lines.
export type ShipQueueRow = {
  sales_id: string;
  order_date: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  ready_count: number;              // fulfilled, unshipped, non-cancelled lines
  planned_courier: string | null;   // courier captured at fulfill
};

// One fulfilled-unshipped line in the ship detail pane.
export type ShipLine = {
  line_id: string;
  item_code: string | null;
  name: string;
  qty: number;
  courier: string | null;           // planned courier from fulfill
};

// ── Receiving (Inbound) module (J2 — the "+" side of stock) ───────────────────
// inbound (0006): qty is SIGNED (negative = stock correction); excluded rows add 0
// sellable stock; ship_id is the free-text join to shipments (incl. the 📦YYMMXXX
// ad-hoc form). needs_review (0015) flags receive-time SKU stubs.
export type InboundLabel = 'Exclude' | 'Hold' | 'Tokopedia';

export type Inbound = {
  inbound_id: number;
  item_code: string | null;          // nullable FK → catalogue (never NULLed for new receipts)
  item_code_raw: string | null;
  qty: number;                       // signed
  ship_id: string | null;
  receive_date: string | null;
  receive_date_raw: string | null;
  is_opening_balance: boolean;
  excluded: boolean;
  label: InboundLabel | null;
  tracking: string | null;
  receive_note: string | null;
  dimension_weight: string | null;   // raw 'L x W x H cm / NNNg'
  transfer_box_id: string | null;
  legacy_ref: string | null;
  created_at: string;
};

// shipments (0007): the forwarder ledger. ship_id is the text join key; status open/
// completed (derived from received_date). contents is [{qty, item}] line-items.
export type ShipmentContentLine = { qty: number | null; item: string | null };

export type Shipment = {
  ship_id: string;
  forwarder_prefix: string | null;
  origin_country: string | null;     // normalized (flag stripped)
  status: 'open' | 'completed' | null;
  ship_date: string | null;
  received_date: string | null;
  tracking: string | null;
  contents: ShipmentContentLine[] | null;
  note: string | null;
  created_at: string;
};

// One row in the arrivals queue: an open shipment with a count of its expected SKUs
// (shipment contents ∪ purchase_orders on the same ship_id — D3).
export type ReceiveQueueRow = {
  ship_id: string;
  origin_country: string | null;
  ship_date: string | null;
  tracking: string | null;
  expected_count: number;            // distinct expected SKUs (0 when nothing was recorded)
};

// One expected SKU in the receive detail, merged from shipment contents AND POs (D3).
// item_code is null when a contents line carries only a raw label that no SKU resolves.
export type ExpectedLine = {
  item_code: string | null;
  raw: string | null;                // original contents 'item' / PO item_code_raw when unresolved
  name: string;
  expected_qty: number;              // Σ expected across contents + POs
  source: 'contents' | 'po' | 'both';
};

// One received line drafted in the detail — what physically arrived for a SKU. qty is
// SIGNED so a negative row records a stock correction. Maps 1:1 to an inbound row on save.
export type ReceiveLine = {
  item_code: string;
  name: string;
  qty: number;                       // signed received qty
  excluded: boolean;
  label: InboundLabel | null;
  dimension_weight: string | null;
};
