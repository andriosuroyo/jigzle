import type { CustomerAddress } from '@jigzle/db/types';

// FT-9: shared one-line label for a saved address — recipient name, else label, else the raw address
// (+ kota), else a numbered fallback. Used by the New (OrderEntry) + Fulfill (FulfillBoard) screens.
export function addressLine(a: CustomerAddress): string {
  return (
    a.recipient_name ||
    a.address_label ||
    [a.raw_address, a.kota].filter(Boolean).join(' · ') ||
    `Address #${a.address_id}`
  );
}
