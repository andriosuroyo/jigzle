// Volumetric weight for the Outbound ship screen — CLIENT PREVIEW ONLY. The record_shipment
// RPC (migration 0029) recomputes these server-side and is authoritative; these mirror its
// formula so the operator sees the same numbers before committing.
//
//   vol_weight        = ceil(p) · ceil(l) · ceil(t) / 6   (p/l/t in cm → result in GRAMS)
//   chargeable_weight = max(real_weight, vol_weight)
//
// GRAMS everywhere (PR26 fix — was /6000/kg): real_weight is entered in grams, so vol must be
// grams too for chargeable = max(real, vol) to compare like units.

export function volWeight(p: number, l: number, t: number): number {
  return (Math.ceil(p) * Math.ceil(l) * Math.ceil(t)) / 6;
}

export function chargeable(realWeight: number, volWeightValue: number): number {
  return Math.max(realWeight, volWeightValue);
}
