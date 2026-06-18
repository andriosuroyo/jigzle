// The one place SKU thumbnail sizes are tuned (docs/014 §1b). Three tiers, in px:
//   sm 36 — search results, dropdowns, table/list rows (glance level)
//   md 72 — "am I handling the RIGHT item?" lines: Sales / Inbound / Fulfill / Outbound contents
//   lg 220 — Catalog detail / edit pane only
// Pass `size={SKU_IMG.md}` instead of a magic number so the scale stays consistent app-wide.
export const SKU_IMG = { sm: 36, md: 72, lg: 220 } as const;
