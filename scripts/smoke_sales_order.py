#!/usr/bin/env python3
"""J2.1 smoke: exercise the create_order write path against the live DB, verify the
rows + the D5 mapping, confirm stock_check does NOT move, prove the phone dedup index,
then clean up everything it created. Uses the service-role key as a TEST HARNESS only
(the app itself uses the anon key + the user's session). Run AFTER 0012 is applied.

  python3 scripts/smoke_sales_order.py
"""
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402

env = load_env()
db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
db.ping()

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")

def rest(method, path, body=None, prefer=None):
    url = f"{db.base}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    h = dict(db.h)
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=db.timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

TEST_PHONE = "629990000001"   # synthetic (no real Indonesian mobile uses 6299…); cleaned up at end
created = {"sales_id": None, "customer_id": None}

try:
    # pick two real SKUs
    skus = rest("GET", "catalogue?select=item_code&limit=2&order=item_code")
    code1, code2 = skus[0]["item_code"], skus[1]["item_code"]
    price1, qty1 = 100_000, 2
    price2, qty2 = 250_000, 1
    total = price1 * qty1 + price2 * qty2          # 450,000
    dp = 200_000

    # stock_check BEFORE
    before = {r["item_code"]: r["available"] for r in
              rest("GET", f"stock_check?item_code=in.({code1},{code2})&select=item_code,available")}

    # test customer + address (direct insert; service role bypasses RLS)
    cust = rest("POST", "customers", body=[{"name": "SMOKE TEST", "phone": TEST_PHONE,
                "phone_raw": "0899-0001-234", "channel": "WHATSAPP"}], prefer="return=representation")[0]
    created["customer_id"] = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust["customer_id"],
                "recipient_name": "Smoke", "raw_address": "Jl. Test 1, Jakarta"}],
                prefer="return=representation")[0]

    # phone dedup: a second insert with the same normalized phone must be rejected (23505)
    dup_rejected = False
    try:
        rest("POST", "customers", body=[{"name": "SMOKE DUP", "phone": TEST_PHONE}], prefer="return=minimal")
    except urllib.error.HTTPError as e:
        dup_rejected = e.code == 409 or "23505" in e.read().decode(errors="replace")
    check("phone unique index rejects duplicate normalized phone", dup_rejected)

    # the DP order via the RPC
    payload = {
        "customer_id": cust["customer_id"],
        "address_id": addr["address_id"],
        "lines": [
            {"item_code": code1, "qty": qty1, "unit_price_idr": price1},
            {"item_code": code2, "qty": qty2, "unit_price_idr": price2},
        ],
        "payment": {"amount_idr": dp, "method": "BCA"},
    }
    sales_id = rest("POST", "rpc/create_order", body={"payload": payload})
    created["sales_id"] = sales_id
    check("create_order returned a JZ-YYMM-#### id", isinstance(sales_id, str) and sales_id.startswith("JZ-"), sales_id)

    order = rest("GET", f"orders?sales_id=eq.{sales_id}&select=*")[0]
    check("order.sales_total_idr = Σ qty×price", order["sales_total_idr"] == total, f'{order["sales_total_idr"]} == {total}')
    check("order.status = 'Need payment' (DP)", order["status"] == "Need payment", order["status"])
    check("order.payment_status = 'Partial' (DP)", order["payment_status"] == "Partial", order["payment_status"])

    olines = rest("GET", f"order_lines?sales_id=eq.{sales_id}&select=*&order=line_id")
    check("2 order_lines written", len(olines) == 2, str(len(olines)))
    check("order_lines.fulfilled_at all NULL (no stock cut)", all(l["fulfilled_at"] is None for l in olines))
    check("order_lines.shipped_at all NULL (no stock cut)", all(l["shipped_at"] is None for l in olines))
    check("order_lines.unit_price_idr stored", {l["unit_price_idr"] for l in olines} == {price1, price2})
    check("line_id = sales_id-n", [l["line_id"] for l in olines] == [f"{sales_id}-1", f"{sales_id}-2"])

    pays = rest("GET", f"payments?sales_id=eq.{sales_id}&select=*")
    check("1 payments row", len(pays) == 1, str(len(pays)))
    check("payment.amount = DP", pays and pays[0]["amount_idr"] == dp, str(pays[0]["amount_idr"]) if pays else "—")
    check("payment.type = 'DP'", pays and pays[0]["type"] == "DP", pays[0]["type"] if pays else "—")

    after = {r["item_code"]: r["available"] for r in
             rest("GET", f"stock_check?item_code=in.({code1},{code2})&select=item_code,available")}
    check("stock_check.available UNCHANGED for both SKUs (order entry moves no stock)",
          before == after, f"before={before} after={after}")

finally:
    # cleanup — order first (cascades lines+payments), then customer (cascades addresses)
    if created["sales_id"]:
        rest("DELETE", f"orders?sales_id=eq.{created['sales_id']}", prefer="return=minimal")
    if created["customer_id"]:
        rest("DELETE", f"customers?customer_id=eq.{created['customer_id']}", prefer="return=minimal")
    print("  (cleanup done — test order/customer removed)")

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
