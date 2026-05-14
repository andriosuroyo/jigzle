import type { ShippingMethod } from '@jigzle/db/types';

export type FxMap = Record<string, number>; // currency code -> rate to IDR

export type ComputeInputs = {
  method: ShippingMethod;
  fx: FxMap;
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
};

export type ComputeResult = {
  method: ShippingMethod;
  fx_source: number;
  fx_rate_ship: number;
  item_cost_idr: number;
  vol_weight_g: number;
  effective_kg: number;
  shipping_cost_idr: number;
  import_tax_idr: number;
  marketplace_fee_idr: number;
  total_cost_idr: number;
  rec_sale_price: number;
  low_margin_idr: number;
};

// Mirrors compute() in Jigzle Calculator.html lines 994-1029, formula-for-formula.
export function compute(input: ComputeInputs): ComputeResult {
  const m = input.method;
  const fx_source = input.fx[m.source_currency] || 0;
  const fx_rate_ship = m.rate_currency === 'IDR' ? 1 : (input.fx[m.rate_currency] || 0);

  const item_cost_idr =
    (input.purchase_price + input.local_shipping + m.warehouse_fee) * fx_source;

  const vol_weight_g = volumeWeight(input.box_p, input.box_l, input.box_t);
  const effective_kg = Math.max(input.real_weight_g / 1000, vol_weight_g / 1000);
  const shipping_cost_idr = effective_kg * m.rate_per_kg * fx_rate_ship;
  const import_tax_idr = m.tax_included
    ? 0
    : (item_cost_idr + shipping_cost_idr) * (input.tax_rate / 100);

  const fee_pct_active = input.marketplace_active ? input.marketplace_rate / 100 : 0;
  const denom = Math.max(0.05, 1 - input.coefficient - fee_pct_active);
  const subtotal_pre_fee = item_cost_idr + shipping_cost_idr + import_tax_idr;
  const rec_sale_price_raw = subtotal_pre_fee / denom;
  const rec_sale_price = Math.round(rec_sale_price_raw / 1000) * 1000;

  const marketplace_fee_idr = input.marketplace_active ? rec_sale_price * fee_pct_active : 0;
  const total_cost_idr =
    item_cost_idr + shipping_cost_idr + import_tax_idr + marketplace_fee_idr;
  const low_margin_idr = rec_sale_price * 0.9 - total_cost_idr;

  return {
    method: m,
    fx_source,
    fx_rate_ship,
    item_cost_idr,
    vol_weight_g,
    effective_kg,
    shipping_cost_idr,
    import_tax_idr,
    marketplace_fee_idr,
    total_cost_idr,
    rec_sale_price,
    low_margin_idr,
  };
}

export function volumeWeight(box_p: number, box_l: number, box_t: number): number {
  return (box_p * box_l * box_t) / 5;
}
