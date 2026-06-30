#!/usr/bin/env python3
"""Reconcile the live customers + sales to the source CSVs (post-import cleanup).

WHY: the original importer (import_jigzle.py :: load_customers) deduped customers by
PHONE but mapped each order's label to a customer with last-write-wins. So one person
who used several numbers split into several phone-keyed customer rows, while ALL their
orders landed on whichever phone-key was written last. The Customer Data sheet is the
source of truth: every "<alias> (last4)" CUSTOMER ID is ONE person, with up to a few
numbers and several addresses.

WHAT THIS DOES, per CUSTOMER ID label in the Customer Data CSV:
  • find the live customer rows that belong to the label (any of their phones is one of
    the label's numbers, plus whatever row currently holds the label's orders);
  • KEEP the record that already holds the orders (fewest orders to re-point), absorbing
    the siblings: re-point every order/hold/shipment/PO/missing-piece at the keeper, move
    addresses across (de-duped), union channels, then delete the emptied siblings;
  • set the keeper's name to the label's alias and order its phones so #1 is the label's
    identity number (the one whose last-4 is the "(XXXX)" code) — so it displays as the
    label, e.g. "Henny Y (1299)";
  • a customer with MORE than three numbers keeps the identity number + the next two and
    is REPORTED (the app holds only three) for a manual decision.

WHAT IT NEVER DOES:
  • never deletes an order (sales above the last CSV date are app-entered → left as is);
  • never deletes / touches a customer that no CSV label claims (new app customers).

SAFETY: dry-run is the default and writes NOTHING. `--csv-report` doesn't even touch the
DB (parses the CSVs only). `--execute` is the only mode that writes, via the SERVICE-ROLE
key in .env.local (same posture as import_jigzle.py). Always run dry-run first, and take
a DB backup before --execute.

USAGE:
  python3 scripts/import/reconcile_customers.py --csv-report \
      --customers Customer_Data.csv --sales Sales_Data.csv --backup Backup_Sales.csv
  python3 scripts/import/reconcile_customers.py            <same args>   # dry-run vs live DB
  python3 scripts/import/reconcile_customers.py --execute  <same args>   # apply
  ... add  --label "Henny Y (1299)"  to scope to one customer (great for a first --execute).
"""
from __future__ import annotations
import argparse
import csv
import os
import re
import sys
from collections import defaultdict

import transforms as t
from db import Client, load_env

CUST_LABEL, CUST_PHONE, CUST_CHANNEL, CUST_ADDR, CUST_ADDRID = 0, 1, 2, 3, 4
SALES_DATE, SALES_LABEL = 2, 3
MAX_PHONES = 3


# ── source CSV → canonical customer model ─────────────────────────────────────
def label_code(label: str) -> str | None:
    """The '(XXXX)' identity code at the end of a CUSTOMER ID, e.g. 'Henny Y (1299)' → '1299'."""
    m = re.search(r"\((\d{2,5})\)\s*$", label or "")
    return m.group(1) if m else None


def read_csv(path: str) -> list[list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.reader(fh))


class CanonicalCustomer:
    __slots__ = ("label", "name", "code", "phones", "channels", "address_count")

    def __init__(self, label: str):
        self.label = label
        self.name = t.name_from_label(label)
        self.code = label_code(label)
        self.phones: list[str] = []        # ordered, distinct, normalized; identity first
        self.channels: list[str] = []      # ordered, distinct canonical platforms
        self.address_count = 0

    def identity_phone(self) -> str | None:
        if not self.code:
            return None
        for p in self.phones:
            if p.endswith(self.code):
                return p
        return None

    def ordered_phones(self) -> list[str]:
        """Identity number first, then the rest in first-seen order."""
        idp = self.identity_phone()
        rest = [p for p in self.phones if p != idp]
        return ([idp] + rest) if idp else list(self.phones)


def build_canonical(customer_csv: str) -> dict[str, CanonicalCustomer]:
    rows = read_csv(customer_csv)[1:]
    out: dict[str, CanonicalCustomer] = {}
    for r in rows:
        if not any((c or "").strip() for c in r):
            continue
        label = t.clean(r[CUST_LABEL] if len(r) > CUST_LABEL else "")
        if not label:
            continue
        cc = out.get(label) or out.setdefault(label, CanonicalCustomer(label))
        p = t.normalize_phone(r[CUST_PHONE] if len(r) > CUST_PHONE else "")
        if p and p not in cc.phones:
            cc.phones.append(p)
        chan, _ig = t.canonical_channel(r[CUST_CHANNEL] if len(r) > CUST_CHANNEL else "")
        if chan and chan not in cc.channels:
            cc.channels.append(chan)
        addr_id = t.clean(r[CUST_ADDRID] if len(r) > CUST_ADDRID else "")
        if addr_id and addr_id.upper() != "#N/A":
            cc.address_count += 1
    return out


def last_known_date(*sales_csvs: str) -> str:
    """Max ORDER DATE across the sales CSVs, as ISO 'YYYY-MM-DD' (CSV uses 'YYYY.MM.DD')."""
    mx = ""
    for path in sales_csvs:
        for r in read_csv(path)[1:]:
            d = t.clean(r[SALES_DATE]) if len(r) > SALES_DATE else ""
            if re.match(r"\d{4}\.\d{2}\.\d{2}", d or ""):
                mx = max(mx, d)
    return mx.replace(".", "-") if mx else ""


# ── live DB readers (read-only; used in dry-run and --execute) ────────────────
def db_get_all(client: Client, table: str, select: str, extra: str = "", page: int = 1000) -> list[dict]:
    out, offset = [], 0
    while True:
        path = f"{table}?select={select}&order=customer_id.asc&limit={page}&offset={offset}"
        if extra:
            path += f"&{extra}"
        chunk = client._req("GET", path) or []
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def addr_key(a: dict) -> str:
    norm = lambda s: re.sub(r"[\s,]+", " ", (s or "").lower()).strip()
    raw = norm(a.get("raw_address"))
    if raw:
        return raw
    return "|".join(norm(a.get(k)) for k in ("street", "kelurahan", "kecamatan", "kota", "provinsi", "negara", "kode_pos"))


# ── planning ──────────────────────────────────────────────────────────────────
class Plan:
    def __init__(self, cc: CanonicalCustomer):
        self.cc = cc
        self.keeper: int | None = None
        self.absorb: list[int] = []
        self.final_phones: list[tuple[str, str]] = []   # (normalized, raw) in #1..#3 order
        self.dropped_phones: list[str] = []
        self.note = ""


FK_TABLES = ("orders", "holds", "outbound_shipments", "purchase_orders", "missing_pieces")


def build_plans(canon, customers, order_count_by_cust, label_holders):
    """Map each canonical customer to a keeper + the records it absorbs.

    label_holders: clean(label) → {customer_id: count} of orders carrying that label, so the
    keeper is literally the record holding the label's orders (even if its phone drifted)."""
    # index every live customer by each of its normalized phones
    by_phone: dict[str, list[dict]] = defaultdict(list)
    for c in customers:
        for col in ("phone", "phone2", "phone3"):
            if c.get(col):
                by_phone[c[col]].append(c)
    cust_by_id = {c["customer_id"]: c for c in customers}

    plans, claimed = [], set()
    for label, cc in canon.items():
        held = label_holders.get(t.clean(label), {})
        group_ids: set[int] = set(i for i in held if i in cust_by_id)   # the label's order-holders
        for p in cc.phones:                                            # + every phone-split sibling
            for c in by_phone.get(p, ()):
                group_ids.add(c["customer_id"])
        group = [cust_by_id[i] for i in group_ids if i in cust_by_id]
        plan = Plan(cc)
        if not group:
            plan.note = "no live customer matches this label's numbers/orders — skipped"
            plans.append(plan)
            continue
        # keeper = the record holding the most of THIS label's orders (fewest to re-point);
        # tie → most total orders, then identity phone, then lowest id
        idp = cc.identity_phone()
        def keyfn(c):
            return (held.get(c["customer_id"], 0),
                    order_count_by_cust.get(c["customer_id"], 0),
                    1 if idp and idp in (c.get("phone"), c.get("phone2"), c.get("phone3")) else 0,
                    -c["customer_id"])
        keeper = max(group, key=keyfn)
        plan.keeper = keeper["customer_id"]
        plan.absorb = sorted(c["customer_id"] for c in group if c["customer_id"] != plan.keeper)

        # final phone order: identity number first, then the label's other numbers (cap 3)
        ordered = cc.ordered_phones()
        plan.final_phones = [(p, p) for p in ordered[:MAX_PHONES]]
        plan.dropped_phones = ordered[MAX_PHONES:]

        for i in group_ids:
            if i in claimed:
                plan.note = (plan.note + "; " if plan.note else "") + f"#{i} also claimed by another label"
            claimed.add(i)
        plans.append(plan)
    return plans


# ── apply (only with --execute) ───────────────────────────────────────────────
def apply_plan(client: Client, plan: Plan, customers_by_id: dict[int, dict]):
    keeper = plan.keeper
    moved_orders = 0
    # 1) re-point every FK row from the absorbed records onto the keeper
    for dup in plan.absorb:
        for table in FK_TABLES:
            res = client._req("PATCH", f"{table}?customer_id=eq.{dup}",
                              body={"customer_id": keeper}, prefer="return=representation") or []
            if table == "orders":
                moved_orders += len(res)
    # 2) move addresses across, skipping any the keeper already has
    keeper_addrs = client._req("GET", f"customer_addresses?select=*&customer_id=eq.{keeper}") or []
    seen = {addr_key(a) for a in keeper_addrs}
    for dup in plan.absorb:
        for a in client._req("GET", f"customer_addresses?select=*&customer_id=eq.{dup}") or []:
            k = addr_key(a)
            if k in seen:
                client._req("DELETE", f"customer_addresses?address_id=eq.{a['address_id']}", prefer="return=minimal")
            else:
                client._req("PATCH", f"customer_addresses?address_id=eq.{a['address_id']}",
                            body={"customer_id": keeper}, prefer="return=minimal")
                seen.add(k)
    # 3) union channels (keeper first), de-duped by platform+handle, cap 3
    chans, seen_ch = [], set()
    for cid in [keeper] + plan.absorb:
        for ch in (customers_by_id.get(cid, {}).get("channels") or []):
            if not ch or not ch.get("platform"):
                continue
            key = (ch.get("platform", "").lower().strip(), ch.get("handle", "").lower().strip())
            if key in seen_ch:
                continue
            seen_ch.add(key)
            if len(chans) < MAX_PHONES:
                chans.append({"platform": str(ch["platform"]), "handle": str(ch.get("handle") or "")})
    # 4) delete the emptied siblings, THEN write the keeper's phones/name/channels (no row
    #    holds those numbers anymore, so the unique phone index can't collide)
    if plan.absorb:
        client._req("DELETE", f"customers?customer_id=in.({','.join(map(str, plan.absorb))})", prefer="return=minimal")
    # store the FULL label as the name (the legacy CUSTOMER ID, e.g. "Henny Y (1299)") — the app shows
    # customers.name verbatim now, with the "(last4)" code baked in rather than appended at display time.
    body = {"name": plan.cc.label, "channels": chans}
    cols = ["phone", "phone2", "phone3"]
    for i, col in enumerate(cols):
        norm = plan.final_phones[i][0] if i < len(plan.final_phones) else None
        body[col] = norm
        body[f"{col}_raw"] = norm
    client._req("PATCH", f"customers?customer_id=eq.{keeper}", body=body, prefer="return=minimal")
    return moved_orders


# ── report / orchestration ────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Reconcile customers + sales to the source CSVs.")
    ap.add_argument("--customers", required=True, help="Customer Data CSV")
    ap.add_argument("--sales", required=True, help="Sales Data CSV (recent)")
    ap.add_argument("--backup", required=True, help="Backup Sales CSV (legacy)")
    ap.add_argument("--label", help="scope to a single CUSTOMER ID label (e.g. 'Henny Y (1299)')")
    ap.add_argument("--csv-report", action="store_true", help="parse CSVs only; never touch the DB")
    ap.add_argument("--preview", metavar="OUT.csv", help="write the post-cleanup customer table (from the CSVs) to a CSV; no DB")
    ap.add_argument("--execute", action="store_true", help="APPLY the plan (writes via service-role key)")
    args = ap.parse_args()

    canon = build_canonical(args.customers)
    last_date = last_known_date(args.sales, args.backup)
    over = {L: cc for L, cc in canon.items() if len(cc.phones) > MAX_PHONES}

    print(f"Customer Data: {len(canon)} customer labels")
    print(f"Last known sales date (CSV): {last_date or '—'}  → app orders after this are left untouched")
    print(f"\nLabels with MORE than {MAX_PHONES} numbers (kept = identity + next {MAX_PHONES - 1}; rest reported): {len(over)}")
    for L, cc in sorted(over.items(), key=lambda kv: -len(kv[1].phones)):
        keep = cc.ordered_phones()[:MAX_PHONES]
        drop = cc.ordered_phones()[MAX_PHONES:]
        print(f"  • {L}: {len(cc.phones)} numbers — keep {keep}; DROP {drop} (decide manually)")

    if args.label:
        cc = canon.get(args.label)
        print(f"\n--label {args.label!r}:", "found" if cc else "NOT in Customer Data")
        if cc:
            print(f"  name={cc.name!r} code={cc.code} phones={cc.ordered_phones()} addresses={cc.address_count}")

    if args.preview:
        with open(args.preview, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["CUSTOMER ID", "NAME", "NUMBER 1", "NUMBER 2", "NUMBER 3",
                        "EXTRA NUMBERS (won't fit)", "# ADDRESSES", "CHANNELS"])
            for label in sorted(canon):
                cc = canon[label]
                ph = cc.ordered_phones()
                w.writerow([label, cc.name, ph[0] if len(ph) > 0 else "",
                            ph[1] if len(ph) > 1 else "", ph[2] if len(ph) > 2 else "",
                            " / ".join(ph[MAX_PHONES:]), cc.address_count, " / ".join(cc.channels)])
        print(f"\n[--preview] Wrote post-cleanup customer table → {args.preview} ({len(canon)} customers). No DB used.")
        return

    if args.csv_report:
        print("\n[--csv-report] No DB access used. Re-run without it for the live plan.")
        return

    # creds from .env.local OR real environment variables (cloud sessions inject them as env vars)
    env = load_env()
    url = env.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (.env.local or environment)")
    client = Client(url, key)
    client.ping()

    print("\nReading live customers + order counts…")
    customers = db_get_all(client, "customers", "customer_id,name,phone,phone2,phone3,channels")
    customers_by_id = {c["customer_id"]: c for c in customers}
    order_rows = db_get_all(client, "orders", "customer_id,customer_ref", extra="customer_id=not.is.null")
    order_count_by_cust: dict[int, int] = defaultdict(int)
    label_holders: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for o in order_rows:
        cid = o.get("customer_id")
        if cid is None:
            continue
        order_count_by_cust[cid] += 1
        ref = t.clean(o.get("customer_ref"))
        if ref:
            label_holders[ref][cid] += 1
    print(f"  {len(customers)} customers, {len(order_rows)} order rows with a customer")

    plans = build_plans(canon, customers, order_count_by_cust, label_holders)
    if args.label:
        plans = [p for p in plans if p.cc.label == args.label]

    to_merge = [p for p in plans if p.keeper and p.absorb]
    no_match = [p for p in plans if not p.keeper]
    total_absorbed = sum(len(p.absorb) for p in to_merge)

    print(f"\nPLAN ({'EXECUTE' if args.execute else 'DRY-RUN — no writes'}):")
    print(f"  labels needing consolidation : {len(to_merge)}")
    print(f"  customer records absorbed+deleted: {total_absorbed}")
    print(f"  labels with no live match    : {len(no_match)}")

    sample = [p for p in plans if p.cc.label == args.label] if args.label else to_merge[:15]
    print(f"\n  sample ({len(sample)} shown):")
    for p in sample:
        ph = [n for n, _ in p.final_phones]
        kept_orders = order_count_by_cust.get(p.keeper, 0)
        line = (f"  • {p.cc.label}: keep #{p.keeper} ({kept_orders} orders) "
                f"← absorb {p.absorb or '—'} | phones #1..#{len(ph)}={ph}")
        if p.dropped_phones:
            line += f" | DROP {p.dropped_phones}"
        if p.note:
            line += f"  [{p.note}]"
        print(line)

    if not args.execute:
        print("\nDRY-RUN complete — nothing was written. Re-run with --execute to apply.")
        return

    print("\nAPPLYING…")
    done = moved = 0
    for p in to_merge:
        moved += apply_plan(client, p, customers_by_id)
        done += 1
        if done % 100 == 0:
            print(f"  …{done}/{len(to_merge)} labels")
    print(f"Done. Consolidated {done} labels, deleted {total_absorbed} records, re-pointed {moved} orders.")


if __name__ == "__main__":
    main()
