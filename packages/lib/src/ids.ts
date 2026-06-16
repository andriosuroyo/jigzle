// Order / line id format — Decision D3.
//
//   sales_id = `JZ-YYMM-####`   (#### restarts at 0001 each month)
//   line_id  = `${sales_id}-${n}`  (n is 1-based)
//
// IMPORTANT: the ATOMIC allocation of the monthly counter happens server-side in the
// `create_order` Postgres function (migration 0012), which takes a per-period advisory
// lock before reading max()+1 — safe regardless of the single-operator assumption. The
// helpers below are the canonical FORMAT that the SQL mirrors; use them for previews,
// labels, and tests only — never for unsynchronized client-side allocation.

const SALES_ID_RE = /^JZ-(\d{4})-(\d{4})$/;

/** `YYMM` for a given date. NOTE: uses the date's local fields; the authoritative
 *  period for a saved order is computed in Asia/Jakarta server-side by create_order. */
export function salesPeriod(d: Date): string {
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

/** `JZ-YYMM-####` from a 4-digit period and a 1-based counter. */
export function formatSalesId(period: string, counter: number): string {
  return `JZ-${period}-${String(counter).padStart(4, '0')}`;
}

/** `${salesId}-${n}` — the line id for the n-th (1-based) line of an order. */
export function lineId(salesId: string, n: number): string {
  return `${salesId}-${n}`;
}

/** Parse a `JZ-YYMM-####` id, or null if it is not in that shape (e.g. a legacy id). */
export function parseSalesId(salesId: string): { period: string; counter: number } | null {
  const m = SALES_ID_RE.exec(salesId);
  if (!m) return null;
  return { period: m[1], counter: parseInt(m[2], 10) };
}

// ── Ad-hoc receiving ship-id — the legacy 📦YYMMXXX form ──────────────────────
//
//   ship_id = `📦YYMMXXX`   (📦 + YYMM + a 3-digit counter that restarts at 001 monthly)
//
// For inbound goods with NO shipments-ledger entry; the 📦 icon is what marks an ad-hoc
// receive. As with the sales/send ids, the ATOMIC allocation happens server-side — the
// `next_adhoc_ship_id` Postgres function (migration 0015) takes a per-period advisory lock
// before reading max()+1. The helpers below are the canonical FORMAT the SQL mirrors; use
// them for previews, labels, and tests only — never for unsynchronized client-side
// allocation. The operator may override the generated id with free text.

const ADHOC_SHIP_ID_RE = /^📦(\d{4})(\d{3})$/;

/** `📦YYMMXXX` from a 4-digit period (see `salesPeriod`) and a 1-based counter. */
export function formatAdhocShipId(period: string, counter: number): string {
  return `📦${period}${String(counter).padStart(3, '0')}`;
}

/** Parse a `📦YYMMXXX` id, or null if it is not in that shape (e.g. a forwarder ship_id). */
export function parseAdhocShipId(shipId: string): { period: string; counter: number } | null {
  const m = ADHOC_SHIP_ID_RE.exec(shipId);
  if (!m) return null;
  return { period: m[1], counter: parseInt(m[2], 10) };
}
