// The one place SKU thumbnail sizes are tuned (docs/014 §1b). Sized by how much sits BESIDE the image:
//   sm  36 — glance level: search results, dropdowns, table/list rows (TWO text-only lines beside it)
//   smd 54 — "am I handling the RIGHT item?" with THREE text-only lines beside it (code / name / note)
//   md  72 — "am I handling the RIGHT item?" with interactive controls beside it (qty steppers, status pills)
//   lg 220 — Catalog detail / edit pane only
// Pass `size={SKU_IMG.md}` instead of a magic number so the scale stays consistent app-wide.
export const SKU_IMG = { sm: 36, smd: 54, md: 72, lg: 220 } as const;
