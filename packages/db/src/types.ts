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
