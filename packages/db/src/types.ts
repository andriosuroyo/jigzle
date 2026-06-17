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
  needs_review: boolean;             // 0015 — receive-time SKU stubs flagged for admin review
  created_at: string;
  updated_at: string;
};

// ── Catalogue (SKU) editor (docs/010 §2) ──────────────────────────────────────
// The editor reads/writes the full catalogue row (every column editable EXCEPT item_code) and
// manages a SKU's barcode links against the composite (barcode, item_code) model (0020).
export type CatalogueRow = Catalogue;

// One barcode link on a SKU, in the per-SKU barcode manager. shared = the same barcode is also on
// another SKU (composite key) → marked, and resolvable in the shared-barcodes tab.
export type BarcodeLink = {
  barcode: string;
  is_verified: boolean;
  shared: boolean;
};

// One shared barcode from the barcode_collisions view (0020): the code + how many SKUs carry it.
export type CollisionRow = {
  barcode: string;
  n: number;
  item_codes: string[];
};

// ── SKU images (docs/011, 0021) ───────────────────────────────────────────────
// has_image = a Drive file matched (authoritative); not_found = no file + ColJ 🖼️; pending = the
// work queue (no file, ColJ ? or blank). Display-only: the bucket holds one ~400px display.webp
// per SKU (the primary); originals stay in Drive.
export type ImageStatus = 'has_image' | 'not_found' | 'pending';

// One candidate file row from sku_images (0021) — metadata only; display_path is the bucket path
// of the generated display.webp, set on the primary alone.
export type SkuImage = {
  id: string;
  item_code: string;
  source: 'edited' | 'pre';
  variant: string;
  source_path: string;
  display_path: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  content_hash: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
};

// One row of the sku_image_resolved view (0021) — the app's only image read (path, never bytes).
export type SkuImageResolved = {
  item_code: string;
  image_status: ImageStatus;
  display_path: string | null;
};

// One row from the stock_snapshot materialized view (0019) — the Inventory screen's read model:
// the stock_check (0009) aggregates per ACTIVE SKU (pending / on_the_way / physical > 0), joined to
// its catalogue name + brand, plus the snapshot's refresh time. Inventory's three states map to
// On order = pending, Being shipped = on_the_way, In warehouse = physical.
export type StockRow = {
  item_code: string;
  name: string | null;          // coalesce(translate_name, original_name)
  brand_prefix: string | null;
  pending: number;              // On order  (PO status Processing)
  on_the_way: number;           // Being shipped (PO status On the way / With Forwarder)
  physical: number;             // In warehouse (on the shelf now)
  available: number;            // sellable now
  reserved: number;             // secondary (fulfilled, not shipped)
  on_hold: number;              // secondary (active holds)
  last_receive: string | null;
  refreshed_at: string;         // ISO timestamp — same for every row in a given refresh
};

// Inventory screen filter (read-only): substring search on item_code/name, a three-state quick
// filter, and a sortable column. state 'all' = any of the three states > 0 (the active set).
export type InventoryState = 'all' | 'on_order' | 'shipping' | 'warehouse';
export type InventorySortColumn =
  | 'item_code'
  | 'name'
  | 'pending'
  | 'on_the_way'
  | 'physical'
  | 'available'
  | 'last_receive';
export type InventoryFilter = {
  search?: string;
  state?: InventoryState;
  sort?: { column: InventorySortColumn; dir: 'asc' | 'desc' };
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

// ── Procurement module (the buying pipeline BEFORE Receiving) ─────────────────
// purchase_orders / suppliers / forwarders (0007). Procurement creates + advances open POs
// and groups them into a forwarder shipment; Receiving owns the terminal 'Received' (set by
// record_receipt, 0015). Column names mirror 0007_procurement.sql exactly.
export type POStatus = 'Processing' | 'On the way' | 'With Forwarder' | 'Received';
// the three states Procurement may set (Receiving owns 'Received')
export type POOpenStatus = 'Processing' | 'On the way' | 'With Forwarder';
export type SupplierType = 'Taobao account' | 'agent' | 'marketplace' | 'other';

export type PurchaseOrder = {
  po_id: number;
  encrypt: string | null;            // legacy import key only (D2 — no new PO number)
  supplier_id: number | null;
  item_code: string | null;          // FK → catalogue
  item_code_raw: string | null;
  qty: number;                       // >= 0
  status: POStatus | null;
  status_since: string | null;
  item_cost: number | null;          // supplier-currency unit cost (no conversion in v1)
  method: string | null;             // domestic courier (EMS / ZTO / SF / ...)
  ship_id: string | null;            // soft join to shipments
  customs_value_usd: number | null;
  tracking_to_wh: string | null;
  tracking_to_forwarder: string | null;
  tracking_to_jigzle: string | null;
  marketplace_order_id: string | null; // Taobao order id (text — 19-digit ids overflow int)
  customer_id: number | null;        // optional: item wanted by a customer
  item_note: string | null;
  shipment_note: string | null;
  input_date: string | null;
  receive_date: string | null;
  created_at: string;
};

export type Supplier = {
  supplier_id: number;
  name: string;                      // unique
  country: string | null;
  flag: string | null;               // leading flag emoji
  type: SupplierType | null;
  created_at: string;
};

export type Forwarder = {
  prefix: string;                    // ship_id prefix (PK): CBL, MTE, SUB, LGB, ...
  name: string | null;
  country: string | null;
  created_at: string;
};

// One row in the open-PO queue (status <> 'Received', newest first), with resolved SKU /
// supplier / customer names plus the editable fields so selecting a row prefills the edit
// form without a refetch.
export type OpenPORow = {
  po_id: number;
  item_code: string | null;
  item_code_raw: string | null;
  name: string;                      // resolved catalogue name (falls back to the code)
  qty: number;
  status: POStatus | null;
  status_since: string | null;
  ship_id: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  item_cost: number | null;
  method: string | null;
  marketplace_order_id: string | null;
  customer_id: number | null;
  customer_name: string | null;
  item_note: string | null;
};

// createPO input — supplier_id + item_code required, qty >= 0; everything else optional.
export type NewPOInput = {
  supplier_id: number;
  item_code: string;
  qty: number;
  item_cost?: number | null;
  method?: string | null;
  marketplace_order_id?: string | null;
  customer_id?: number | null;
  item_note?: string | null;
};

// groupIntoShipment payload → the group_pos_into_shipment RPC (0018). ship_id is free text in
// the '<PREFIX> <n>' form (no allocator — forwarder ship-ids are externally assigned).
export type GroupShipmentInput = {
  ship_id: string;
  po_ids: number[];
  forwarder_prefix: string;
  origin_country?: string | null;
  ship_date?: string | null;         // 'YYYY-MM-DD'
};
