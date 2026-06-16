// Volumetric weight for the Outbound ship screen — CLIENT PREVIEW ONLY. The record_shipment
// RPC (migration 0014) recomputes these server-side and is authoritative; these mirror its
// formula so the operator sees the same numbers before committing.
//
//   vol_weight        = ceil(p) · ceil(l) · ceil(t) / 6000   (p/l/t in cm)
//   chargeable_weight = max(real_weight, vol_weight)
//
// real_weight and the result share whatever unit the operator enters consistently.

export function volWeight(p: number, l: number, t: number): number {
  return (Math.ceil(p) * Math.ceil(l) * Math.ceil(t)) / 6000;
}

export function chargeable(realWeight: number, volWeightValue: number): number {
  return Math.max(realWeight, volWeightValue);
}
