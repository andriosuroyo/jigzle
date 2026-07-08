// PR241 — one rule for "is this a real catalogue name worth showing on the 2nd line?". A row shows the
// SKU code on line 1 and the name on line 2 (left-aligned); when there's no genuine name — blank, the "—"
// placeholder, or a fallback that just repeats the code — the name line is dropped and the code stands
// alone (vertically centred). Used across the To-buy / Purchasing card lists so unregistered SKUs read
// cleanly instead of showing "—" or the code twice.
export function isRealName(name: string | null | undefined, code: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  return n !== '' && n !== '—' && n !== (code ?? '').trim();
}
