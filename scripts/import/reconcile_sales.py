#!/usr/bin/env python3
"""Reconcile the sales cluster (customers + orders + order_lines) to the canonical CSVs.

Three inputs: Customer Data, Sales Data (recent), Backup Sales (older, 2015-2023). The orders cluster
is FULLY RELOADED (delete-all orders → FK-cascades order_lines + payments); customers are ADD-MISSING
(reused by phone, never deleted — so holds / purchase_orders / missing_pieces FKs stay intact).

Per docs/sales-import-plan.md (locked decisions):
  • Total only — orders.sales_total_idr carries the order total; order_lines.unit_price_idr stays NULL.
  • Stock cuts from status — fulfilled_at = FULFILL DATE; shipped_at set when the LINE's status is
    Complete; is_cancelled when the line or order is Cancelled. So historical sales deplete stock.
  • customer_id is generated → orders link to customers by the CUSTOMER label (built at customer load).
  • Sales + Backup overlap 2020-23 → dedupe by sales_id (Sales Data wins).

Column logic mirrors import_jigzle.load_customers / load_orders. Money is '000 IDR (×1000). A row whose
ITEM CODE starts with 📦 is the order HEADER (carries the total), not a line. Addresses are NOT loaded
here (order address_id stays NULL — Fulfill confirms the address; not needed for stock/revenue/LTV).

Usage (from repo root):
    python3 scripts/import/reconcile_sales.py CUSTOMER.csv SALES.csv BACKUP.csv            # DRY-RUN
    python3 scripts/import/reconcile_sales.py CUSTOMER.csv SALES.csv BACKUP.csv --execute  # write
"""
from __future__ import annotations
import csv
import sys
from collections import Counter, OrderedDict, defaultdict

import transforms as t  # type: ignore
from db import load_env, Client  # type: ignore

ORDER_STATUS = {"need payment": "Need payment", "need send": "Need send",
                "complete": "Complete", "cancel": "Cancelled", "cancelled": "Cancelled"}
PAY_STATUS = {"paid": "Paid", "unpaid": "Unpaid", "partial": "Partial", "deposit": "Partial", "cancel": "Cancel"}


def gi(row, i):
    return row[i] if i < len(row) else None


def canon_status(v):
    return ORDER_STATUS.get((t.clean(v) or "").lower())


def canon_pay(v):
    return PAY_STATUS.get((t.clean(v) or "").lower())


def is_header(row):
    ic = gi(row, 4)
    return ic is not None and str(ic).startswith("📦")


# ── Customer Data → dedup customers (by phone, else label) + label→key map ──────
def parse_customers(path):
    rows = list(csv.reader(open(path, newline="", encoding="utf-8-sig")))[1:]
    by_key, key_order, label_to_key = OrderedDict(), [], {}
    for row in rows:
        if not any(t.clean(c) for c in row):
            continue
        label = t.clean(gi(row, 0))
        phone = t.normalize_phone(gi(row, 1))
        if not label and not phone:
            continue
        key = phone or f"label:{label}"
        if key not in by_key:
            chan, ig = t.canonical_channel(gi(row, 2))
            by_key[key] = {"name": t.name_from_label(label), "phone": phone,
                           "phone_raw": t.clean(gi(row, 1)), "channel": chan,
                           "channel_raw": t.clean(gi(row, 2)), "ig_handle": ig}
            key_order.append(key)
        if label:
            label_to_key[label] = key
    return by_key, key_order, label_to_key


# ── Sales/Backup → orders + lines (customer_id/item_code resolved at execute) ────
def parse_sales(path, seen_ids):
    """Group rows by sales_id; build one order (from the header / first totalled row) + its lines.
    Skips sales_ids already in `seen_ids` (Sales Data wins over Backup). Returns (orders, lines, rep)."""
    rows = list(csv.reader(open(path, newline="", encoding="utf-8-sig")))[1:]
    groups = OrderedDict()
    for row in rows:
        if not any(t.clean(c) for c in row):
            continue
        sid = t.clean(gi(row, 0))
        if not sid or sid in seen_ids:
            continue
        groups.setdefault(sid, []).append(row)

    orders, lines, rep = [], [], Counter()
    for sid, grp in groups.items():
        headers = [r for r in grp if is_header(r)]
        line_rows = [r for r in grp if not is_header(r)]
        src = headers[0] if headers else next((r for r in line_rows if t.clean(gi(r, 9))), grp[0])
        order_status = canon_status(gi(src, 8))
        cust_ref = t.clean(gi(src, 3))
        total = t.to_idr_thousands(gi(src, 9))
        pay_status = canon_pay(gi(src, 11))
        orders.append({
            "sales_id": sid,
            "customer_ref": cust_ref,
            "order_date": t.parse_date(gi(src, 2)),
            "status": order_status,
            "sales_total_idr": total,
            "paid_idr": total if pay_status == "Paid" and total else 0,  # heuristic for LTV paid
            "payment_method": t.clean(gi(src, 10)),
            "payment_status": pay_status,
            "order_note": t.clean(gi(src, 7)),
        })
        rep["orders"] += 1
        if headers:
            rep["batch_orders"] += 1
        for r in line_rows:
            line_status = canon_status(gi(r, 8))
            ff = t.dt(gi(r, 14))
            courier, track = t.split_courier(gi(r, 13))
            lines.append({
                "sales_id": sid,
                "line_id_in": t.clean(gi(r, 1)),
                "item_code_in": t.clean(gi(r, 4)),
                "qty": t.to_int(gi(r, 5)) or 0,
                "item_link": t.clean(gi(r, 6)),
                "line_note": t.clean(gi(r, 7)),
                "courier": courier,
                "courier_tracking": track,
                "fulfilled_at": ff,
                "shipped_at": ff if line_status == "Complete" else None,
                "is_cancelled": (line_status == "Cancelled") or (order_status == "Cancelled"),
            })
            rep["lines"] += 1
    return orders, lines, rep


def page_all(client, table, select, order):
    out, offset = [], 0
    while True:
        page = client._req("GET", f"{table}?select={select}&order={order}&limit=1000&offset={offset}") or []
        if not page:
            break
        out.extend(page)
        offset += len(page)
    return out


def main():
    args = sys.argv[1:]
    execute = "--execute" in args
    paths = [a for a in args if not a.startswith("-")]
    if len(paths) < 3:
        print("usage: reconcile_sales.py <CUSTOMER.csv> <SALES.csv> <BACKUP.csv> [--execute]", file=sys.stderr)
        sys.exit(2)
    cust_path, sales_path, backup_path = paths[0], paths[1], paths[2]

    by_key, key_order, label_to_key = parse_customers(cust_path)
    s_orders, s_lines, s_rep = parse_sales(sales_path, set())
    seen = {o["sales_id"] for o in s_orders}
    b_orders, b_lines, b_rep = parse_sales(backup_path, seen)
    orders = s_orders + b_orders
    lines = s_lines + b_lines

    st = Counter(o["status"] or "(none)" for o in orders)
    print("── reconcile report ───────────────────────────")
    print(f"  customers (deduped)  {len(key_order)}")
    print(f"  orders               {len(orders)}  (sales {s_rep['orders']} + backup {b_rep['orders']}; dedup-skipped backup sharing a sales_id)")
    print(f"  batch-format orders  {s_rep['batch_orders'] + b_rep['batch_orders']}")
    print(f"  order lines          {len(lines)}")
    print(f"  status dist          {dict(st.most_common())}")
    shipped = sum(1 for ln in lines if ln['shipped_at'])
    print(f"  lines shipped (cut)  {shipped} | cancelled {sum(1 for ln in lines if ln['is_cancelled'])}")

    if not execute:
        print("\nDRY-RUN — nothing written. Re-run with --execute to load (verify the numbers first).")
        for o in orders[:4]:
            print("   order:", {k: o[k] for k in ("sales_id", "customer_ref", "order_date", "status", "sales_total_idr")})
        return

    env = load_env()
    client = Client(env.get("NEXT_PUBLIC_SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    client.ping()

    # 1) catalogue codes (FK) — paged past the 1000-row cap
    valid = {c["item_code"] for c in page_all(client, "catalogue", "item_code", "item_code")}
    print(f"  catalogue codes      {len(valid)}")

    # 2) customers — reuse existing by phone, insert missing; build label → customer_id
    phone_to_id = {}
    for c in page_all(client, "customers", "customer_id,phone", "customer_id"):
        if c["phone"]:
            phone_to_id[c["phone"]] = c["customer_id"]
    key_to_id, to_insert, insert_keys = {}, [], []
    for k in key_order:
        cust = by_key[k]
        if cust["phone"] and cust["phone"] in phone_to_id:
            key_to_id[k] = phone_to_id[cust["phone"]]
        else:
            to_insert.append(cust)
            insert_keys.append(k)
    if to_insert:
        made = client.insert("customers", to_insert, returning=True)
        for k, row in zip(insert_keys, made):
            key_to_id[k] = row["customer_id"]
    label_to_id = {lbl: key_to_id.get(key) for lbl, key in label_to_key.items()}
    print(f"  customers (+{len(to_insert)} new) {len(key_to_id)}")

    # 3) orders — full reload (delete-all cascades order_lines + payments).
    #    FIRST clear outbound_shipments' refs to orders/order_lines: those FKs are NO ACTION, so they
    #    would block the orders delete (and the cascade to order_lines). The rows are denormalized —
    #    History/reports read their own columns, not the join — so nulling the link is harmless.
    print("\n  clearing outbound_shipments → orders/order_lines refs (FK guard)…")
    client._req("PATCH", "outbound_shipments?or=(sales_id.not.is.null,order_line_id.not.is.null)",
                body={"sales_id": None, "order_line_id": None}, prefer="return=minimal")
    print("  reloading orders + order_lines (delete-all orders → cascade)…")
    client.delete_all("orders")

    o_unmatched_cust = 0
    o_db = []
    for o in orders:
        cid = label_to_id.get(o["customer_ref"]) if o["customer_ref"] else None
        if o["customer_ref"] and cid is None:
            o_unmatched_cust += 1
        o_db.append({
            "sales_id": o["sales_id"], "customer_id": cid, "customer_ref": o["customer_ref"],
            "order_date": o["order_date"], "status": o["status"], "sales_total_idr": o["sales_total_idr"],
            "paid_idr": o["paid_idr"], "payment_method": o["payment_method"],
            "payment_status": o["payment_status"], "order_note": o["order_note"],
        })
    client.insert("orders", o_db)
    print(f"  orders inserted      {len(o_db)} (customer unmatched {o_unmatched_cust})")

    # 4) order_lines — resolve item_code, ensure unique line_id
    l_db, l_unmatched, seen_lid = [], 0, set()
    for i, ln in enumerate(lines):
        code = ln["item_code_in"]
        ok = bool(code) and code in valid
        if code and not ok:
            l_unmatched += 1
        lid = ln["line_id_in"] or f"{ln['sales_id']}-{i}"
        if lid in seen_lid:
            lid = f"{lid}-{i}"
        seen_lid.add(lid)
        l_db.append({
            "line_id": lid, "sales_id": ln["sales_id"],
            "item_code": code if ok else None, "item_code_raw": None if ok else code,
            "qty": ln["qty"], "item_link": ln["item_link"], "line_note": ln["line_note"],
            "courier": ln["courier"], "courier_tracking": ln["courier_tracking"],
            "fulfilled_at": ln["fulfilled_at"], "shipped_at": ln["shipped_at"],
            "is_cancelled": ln["is_cancelled"],
        })
    client.insert("order_lines", l_db)
    print(f"  order_lines inserted {len(l_db)} (item unmatched {l_unmatched} → item_code_raw)")
    print(f"\n  done — orders {client.count('orders')} · order_lines {client.count('order_lines')}.")


if __name__ == "__main__":
    main()
