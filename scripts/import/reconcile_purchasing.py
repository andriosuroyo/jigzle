#!/usr/bin/env python3
"""Reconcile the purchasing pipeline (suppliers / forwarders / shipments / purchase_orders) to the
canonical "Order Data" CSV, cross-checked against the "Inbound Data" CSV.

Order Data is the per-item purchasing record (one row per PO line). Inbound Data is the receipt
authority. The rule (Andrio):
  • A ship-id that appears in Inbound is RECEIVED — its items are History.
      - an Order item that arrived (its code is in that ship's inbound rows) → status 'Received'.
      - an Order item that did NOT arrive → status 'With Forwarder' (back to Purchasing's "To ship").
  • A ship-id NOT in Inbound is still open → keep its Order-Data status (blank → 'Processing').

purchase_orders is FULLY RELOADED from Order Data (delete-all + insert) — the sheet is the master, so
app-created POs (Planned items, test rows) are replaced. suppliers / forwarders are insert-missing;
shipments are upserted (received ships get status='completed' + received_date from Inbound).

Per-shipment vs per-item (History): shipment-level fields (forwarder, receive date, tracking→forwarder,
tracking→jigzle, shipment notes, ship_date) live on the shipments row; per-item fields (supplier, qty,
cost, product link, method, tracking→WH, Taobao id) stay on purchase_orders.

Usage (from repo root):
    python3 scripts/import/reconcile_purchasing.py ORDER.csv INBOUND.csv            # DRY-RUN (no DB)
    python3 scripts/import/reconcile_purchasing.py ORDER.csv INBOUND.csv --execute  # write to DB

Dry-run parses both CSVs, applies the cross-check, prints a reconciliation report, and writes NOTHING.
--execute resolves item_codes/suppliers/forwarders against the live DB, upserts shipments, then
delete-alls + reloads purchase_orders via the SERVICE-ROLE key from .env.local. Verify the dry-run
numbers first.
"""
from __future__ import annotations
import csv
import re
import sys
from collections import Counter, defaultdict

from db import load_env, Client  # type: ignore

PREFIX_RE = re.compile(r"^([A-Za-z]+)")
OPEN_STATUSES = {"Processing", "On the way", "With Forwarder"}

# Suppliers were imported flag-stripped (name in `name`, flag in `flag`) — match that so we REUSE
# existing suppliers instead of creating "🇨🇳 …" duplicates (transforms.strip_flag parity).
_FLAG_RE = re.compile(r"^([\U0001F1E6-\U0001F1FF]{2}|🌎|🌏|🌍)\s*")
_FLAG_COUNTRY = {"🇨🇳": "China", "🇯🇵": "Japan", "🇹🇼": "Taiwan", "🇭🇰": "Hong Kong",
                 "🇰🇷": "Korea", "🇺🇸": "USA", "🌎": "Worldwide", "🌏": "Worldwide", "🌍": "Worldwide"}


def strip_flag(s):
    """('🇨🇳 1709-892-4989') → ('🇨🇳', '1709-892-4989')."""
    s = clean(s) or ""
    m = _FLAG_RE.match(s)
    if m:
        return m.group(1), s[m.end():].strip()
    return None, s


def clean(v):
    if v is None:
        return None
    s = str(v).replace("\xa0", " ").strip()
    return s or None


def parse_date(v):
    """'2026.06.13' / '2026-06-13' / '2026/06/13' → 'YYYY-MM-DD' (or None)."""
    s = clean(v)
    if not s:
        return None
    m = re.match(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def to_num(v):
    s = clean(v)
    if not s:
        return None
    s = s.replace(",", "")
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None


def prefix_of(ship_id):
    m = PREFIX_RE.match(ship_id or "")
    return m.group(1) if m else None


# ── Inbound Data: receipt authority ────────────────────────────────────────────
def parse_inbound(path):
    """→ (ship_items: ship → set(item_code), ship_recv: ship → 'YYYY-MM-DD'). The real header is the
    file's SECOND row (the first is a spacer); columns: Item Code, Qty, Ship ID, Receive Date, …"""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    if len(rows) < 2:
        return {}, {}
    hdr = [clean(c) or "" for c in rows[1]]
    ix = {h: i for i, h in enumerate(hdr)}
    iCode, iShip, iRecv = ix.get("Item Code"), ix.get("Ship ID"), ix.get("Receive Date")
    ship_items = defaultdict(set)
    ship_recv = {}
    for r in rows[2:]:
        g = lambda i: clean(r[i]) if i is not None and i < len(r) else None  # noqa: E731
        ship = g(iShip)
        if not ship:
            continue
        code = g(iCode)
        if code:
            ship_items[ship].add(code)
        d = parse_date(g(iRecv))
        if d and ship not in ship_recv:
            ship_recv[ship] = d
    return ship_items, ship_recv


# ── Order Data: the per-item purchasing record ─────────────────────────────────
def parse_order(path):
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        ix = {h: i for i, h in enumerate(header or [])}

        def col(*names):
            for n in names:
                if n in ix:
                    return ix[n]
            return None
        c = {
            "supplier": col("ACCOUNT / SUPPLIER"),
            "input_date": col("INPUT DATE"),
            "item_code": col("ITEM CODE"),
            "qty": col("QTY"),
            "status": col("STATUS"),
            "item_cost": col("ITEM COST"),
            "item_link": col("ITEM LINK"),
            "method": col("METHOD"),
            "tracking_to_wh": col("TRACKING TO WH"),
            "item_note": col("ITEM NOTES"),
            "ship_id": col("SHIP ID"),
            "taobao": col("TAOBAO ORDER ID 订单号", "TAOBAO ORDER ID"),
            "tk_forwarder": col("TRACKING\nTO FORWARDER", "TRACKING TO FORWARDER"),
            "tk_jigzle": col("TRACKING \nTO JIGZLE", "TRACKING TO JIGZLE"),
            "shipment_note": col("SHIPMENT NOTES"),
            "forwerder_date": col("FORWERDER"),
        }
        for raw in reader:
            if not any(clean(x) for x in raw):
                continue
            g = lambda key: clean(raw[c[key]]) if c[key] is not None and c[key] < len(raw) else None  # noqa: E731
            sup_raw = g("supplier")
            sup_flag, sup_name = strip_flag(sup_raw) if sup_raw else (None, None)
            rows.append({
                "supplier": sup_name or None,        # flag-stripped, to match existing suppliers
                "supplier_flag": sup_flag,
                "input_date": parse_date(g("input_date")),
                "item_code": g("item_code"),
                "qty": to_num(g("qty")) or 0,
                "status": g("status"),
                "item_cost": to_num(g("item_cost")),
                "product_link": g("item_link"),
                "method": g("method"),
                "tracking_to_wh": g("tracking_to_wh"),
                "item_note": g("item_note"),
                "ship_id": g("ship_id"),
                "marketplace_order_id": g("taobao"),
                "tracking_to_forwarder": g("tk_forwarder"),
                "tracking_to_jigzle": g("tk_jigzle"),
                "shipment_note": g("shipment_note"),
                "forwerder_date": parse_date(g("forwerder_date")),
            })
    return rows


def assign(rows, ship_items, ship_recv):
    """Set each row's final status + receive_date via the cross-check. Returns a report Counter."""
    rep = Counter()
    inbound_ships = set(ship_items)
    for r in rows:
        ship = r["ship_id"]
        received_ship = bool(ship) and ship in inbound_ships
        if received_ship:
            arrived = r["item_code"] in ship_items.get(ship, set())
            if arrived:
                r["final_status"] = "Received"
                r["receive_date"] = ship_recv.get(ship)
                rep["received"] += 1
            else:
                r["final_status"] = "With Forwarder"  # expected but missing → back to "To ship"
                r["receive_date"] = None
                rep["to_ship_missing"] += 1
        else:
            st = r["status"] if r["status"] in OPEN_STATUSES else "Processing"
            r["final_status"] = st
            r["receive_date"] = None
            rep[f"open_{st}"] += 1
    return rep


def build_shipments(rows, ship_items, ship_recv):
    """One shipment row per ship-id (shipment-level fields, first non-blank per ship)."""
    inbound_ships = set(ship_items)
    byship = {}
    for r in rows:
        ship = r["ship_id"]
        if not ship:
            continue
        s = byship.get(ship)
        if not s:
            s = byship[ship] = {
                "ship_id": ship,
                "forwarder_prefix": prefix_of(ship),
                "status": "completed" if ship in inbound_ships else "open",
                "ship_date": None,
                "received_date": ship_recv.get(ship) if ship in inbound_ships else None,
                "tracking": None,
                "note": None,
            }
        if s["ship_date"] is None and r["forwerder_date"]:
            s["ship_date"] = r["forwerder_date"]
        if s["tracking"] is None and r["tracking_to_jigzle"]:
            s["tracking"] = r["tracking_to_jigzle"]
        if s["note"] is None and r["shipment_note"]:
            s["note"] = r["shipment_note"]
    return list(byship.values())


def upsert(client, table, rows, on_conflict, batch=500):
    for i in range(0, len(rows), batch):
        client._req("POST", f"{table}?on_conflict={on_conflict}",
                    body=rows[i:i + batch], prefer="resolution=merge-duplicates,return=minimal")


def main():
    args = sys.argv[1:]
    execute = "--execute" in args
    paths = [a for a in args if not a.startswith("-")]
    if len(paths) < 2:
        print("usage: reconcile_purchasing.py <ORDER.csv> <INBOUND.csv> [--execute]", file=sys.stderr)
        sys.exit(2)

    order_rows = parse_order(paths[0])
    ship_items, ship_recv = parse_inbound(paths[1])
    rep = assign(order_rows, ship_items, ship_recv)
    shipments = build_shipments(order_rows, ship_items, ship_recv)

    order_ships = {r["ship_id"] for r in order_rows if r["ship_id"]}
    received_ships = order_ships & set(ship_items)

    print("── reconcile report ───────────────────────────")
    print(f"  order rows           {len(order_rows)}")
    print(f"  distinct ship-ids    {len(order_ships)}")
    print(f"  received ships       {len(received_ships)}")
    print(f"  open ships           {len(order_ships - set(ship_items))}")
    print(f"  → Received items     {rep['received']}")
    print(f"  → To-ship (missing)  {rep['to_ship_missing']}")
    for k in sorted(rep):
        if k.startswith("open_"):
            print(f"  → open {k[5:]:14} {rep[k]}")
    print(f"  shipments to upsert  {len(shipments)}")
    print(f"  distinct suppliers   {len({r['supplier'] for r in order_rows if r['supplier']})}")
    print(f"  distinct forwarders  {len({prefix_of(s) for s in order_ships if prefix_of(s)})}")
    print(f"  distinct SKUs        {len({r['item_code'] for r in order_rows if r['item_code']})}")

    if not execute:
        print("\nDRY-RUN — nothing written. Re-run with --execute to load (verify the numbers first).")
        for r in order_rows[:5]:
            print("   sample:", {k: r[k] for k in ("item_code", "qty", "supplier", "ship_id", "final_status", "receive_date")})
        return

    env = load_env()
    client = Client(env.get("NEXT_PUBLIC_SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    client.ping()

    # 1) catalogue codes (FK) — unmatched → item_code NULL, keep raw. PostgREST caps each response at
    # its db-max-rows (Supabase default 1000), so page by the ACTUAL returned count and stop only on an
    # empty page — never trust a single `limit=N` to return N (the old `limit=2000` silently truncated).
    valid = set()
    offset = 0
    while True:
        page = client._req("GET", f"catalogue?select=item_code&order=item_code&limit=1000&offset={offset}") or []
        if not page:
            break
        valid.update(c["item_code"] for c in page)
        offset += len(page)
    print(f"  catalogue codes      {len(valid)}")

    # 2) suppliers — read existing, insert missing, map name → id (same robust paging)
    sup_map = {}
    offset = 0
    while True:
        page = client._req("GET", f"suppliers?select=supplier_id,name&order=supplier_id&limit=1000&offset={offset}") or []
        if not page:
            break
        for s in page:
            if s["name"]:
                sup_map[s["name"]] = s["supplier_id"]
        offset += len(page)
    want_sup = {r["supplier"] for r in order_rows if r["supplier"]}
    flag_by_name = {r["supplier"]: r["supplier_flag"] for r in order_rows if r["supplier"] and r["supplier_flag"]}
    missing_sup = sorted(want_sup - set(sup_map))
    if missing_sup:
        new_rows = [{"name": n, "flag": flag_by_name.get(n),
                     "country": _FLAG_COUNTRY.get(flag_by_name.get(n) or "")} for n in missing_sup]
        made = client.insert("suppliers", new_rows, returning=True)
        for n, row in zip(missing_sup, made):
            sup_map[n] = row["supplier_id"]
    print(f"  suppliers (+{len(missing_sup)} new) {len(sup_map)}")

    # 3) forwarders — insert missing prefixes (shipments.forwarder_prefix FK)
    have_fwd = set()
    page = client._req("GET", "forwarders?select=prefix&limit=2000") or []
    have_fwd.update(f["prefix"] for f in page)
    want_fwd = {s["forwarder_prefix"] for s in shipments if s["forwarder_prefix"]}
    missing_fwd = sorted(want_fwd - have_fwd)
    if missing_fwd:
        client.insert("forwarders", [{"prefix": p} for p in missing_fwd])
    print(f"  forwarders (+{len(missing_fwd)} new)")

    # 4) shipments — upsert (received ships → completed + received_date)
    upsert(client, "shipments", shipments, "ship_id")
    print(f"  shipments upserted   {len(shipments)}")

    # 5) purchase_orders — full reload
    db_rows, unmatched = [], 0
    for r in order_rows:
        code = r["item_code"]
        ok = bool(code) and code in valid
        if code and not ok:
            unmatched += 1
        db_rows.append({
            "supplier_id": sup_map.get(r["supplier"]) if r["supplier"] else None,
            "item_code": code if ok else None,
            "item_code_raw": None if ok else code,
            "qty": int(r["qty"]) if r["qty"] else 0,
            "status": r["final_status"],
            "status_since": r["input_date"],
            "item_cost": r["item_cost"],
            "method": r["method"],
            "ship_id": r["ship_id"],
            "tracking_to_wh": r["tracking_to_wh"],
            "tracking_to_forwarder": r["tracking_to_forwarder"],
            "tracking_to_jigzle": r["tracking_to_jigzle"],
            "marketplace_order_id": r["marketplace_order_id"],
            "item_note": r["item_note"],
            "shipment_note": r["shipment_note"],
            "product_link": r["product_link"],
            "input_date": r["input_date"],
            "receive_date": r["receive_date"],
        })
    print(f"  unmatched SKUs       {unmatched} (stored in item_code_raw)")
    print("\nReloading purchase_orders (delete-all + insert)…")
    client.delete_all("purchase_orders")
    client.insert("purchase_orders", db_rows)
    print(f"  done — {client.count('purchase_orders')} rows now in purchase_orders.")


if __name__ == "__main__":
    main()
