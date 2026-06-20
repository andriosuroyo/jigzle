#!/usr/bin/env python3
"""PR27 Orders smoke: exercise mark_order_paid + unfulfill_order against the live DB, then clean up
ALL test rows and confirm every touched SKU returns to its pre-test baseline (zero residual).
Uses the service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER 0030 is
applied.

  CASE 1  mark_order_paid : a Partial (DP) order, topped up to full → flips to Paid / Need send,
                            and paid_idr == Σ payments throughout (create_order seeds paid_idr; the
                            top-up adds a Settlement ledger row).
  CASE 2a unfulfill_order : a fulfilled order → stock restored (reserved↓ / available↑), courier
                            fields nulled, payment untouched, order stays Need send.
  CASE 2b unfulfill_order : holds are NOT re-created — available fully restores (not to the held
                            level), and the released hold stays released.

  python3 scripts/smoke_orders.py
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

def stock(code):
    r = rest("GET", f"stock_check?item_code=eq.{code}&select=available,reserved,physical,on_hold")
    return r[0] if r else {"available": 0, "reserved": 0, "physical": 0, "on_hold": 0}

def order_row(sid):
    r = rest("GET", f"orders?sales_id=eq.{sid}&select=status,payment_status,paid_idr,sales_total_idr")
    return r[0] if r else None

def sum_payments(sid):
    rows = rest("GET", f"payments?sales_id=eq.{sid}&select=amount_idr") or []
    return sum(r["amount_idr"] for r in rows)

def line_ids(sid):
    rows = rest("GET", f"order_lines?sales_id=eq.{sid}&select=line_id&order=line_id") or []
    return [r["line_id"] for r in rows]

TEST_PHONE = "629990000003"
created_orders, created_holds = [], []
cust_id = None
addr_id = None

try:
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.10&order=item_code&limit=3")
    if len(skus) < 3:
        skus = rest("GET", "catalogue?select=item_code&order=item_code&limit=3")
        skus = [{"item_code": s["item_code"]} for s in skus]
    codes = [s["item_code"] for s in skus]
    A, B, C = codes
    base = {c: stock(c) for c in codes}     # pre-test baselines (capture BEFORE any mutation)

    cust = rest("POST", "customers", body=[{"name": "ORD SMOKE", "phone": TEST_PHONE, "phone_raw": "ord"}],
                prefer="return=representation")[0]
    cust_id = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust_id, "recipient_name": "ORD",
                "raw_address": "Jl. Orders 1"}], prefer="return=representation")[0]
    addr_id = addr["address_id"]

    def create_order(lines, payment=None):
        payload = {"customer_id": cust_id, "address_id": addr_id, "lines": lines}
        if payment:
            payload["payment"] = payment
        sid = rest("POST", "rpc/create_order", body={"payload": payload})
        created_orders.append(sid)
        return sid

    def fulfill(sid):
        return rest("POST", "rpc/fulfill_order", body={"p_sales_id": sid, "p_line_ids": line_ids(sid),
                    "p_address_id": addr_id, "p_courier": "JNE", "p_tracking": "TRK-ORD",
                    "p_courier_speed": "REG", "p_courier_label": "JNE REG"})

    def unfulfill(sid):
        return rest("POST", "rpc/unfulfill_order", body={"p_sales_id": sid})

    # ── CASE 1: mark_order_paid (Partial DP → topped up to full) ──
    print("\n-- CASE 1: mark_order_paid --")
    sid1 = create_order([{"item_code": A, "qty": 1, "unit_price_idr": 100000}],
                        payment={"amount_idr": 40000, "method": "BCA"})
    o = order_row(sid1)
    check("DP order starts Need payment / Partial", o["status"] == "Need payment" and o["payment_status"] == "Partial", str(o))
    check("create_order seeded paid_idr = DP (40000)", o["paid_idr"] == 40000, f'paid_idr={o["paid_idr"]}')
    check("paid_idr == Σ payments after create (40000)", o["paid_idr"] == sum_payments(sid1), f'Σ={sum_payments(sid1)}')
    check("no stock moved by an unfulfilled order (A baseline)", stock(A)["available"] == base[A]["available"])

    res = rest("POST", "rpc/mark_order_paid", body={"p_sales_id": sid1, "p_amount": 60000, "p_method": "BCA"})
    check("mark_order_paid returns Paid", res["payment_status"] == "Paid", str(res))
    check("mark_order_paid flips status to Need send", res["status"] == "Need send", str(res))
    check("mark_order_paid paid=100000, balance=0", res["paid"] == 100000 and res["balance"] == 0, str(res))
    o = order_row(sid1)
    check("order row now Paid / Need send", o["status"] == "Need send" and o["payment_status"] == "Paid", str(o))
    check("paid_idr == total (100000)", o["paid_idr"] == 100000, f'paid_idr={o["paid_idr"]}')
    check("paid_idr == Σ payments after top-up (DP 40000 + Settlement 60000)", o["paid_idr"] == sum_payments(sid1),
          f'Σ={sum_payments(sid1)}')

    # ── CASE 2a: unfulfill_order restores stock; payment untouched; courier nulled ──
    print("\n-- CASE 2a: unfulfill restores stock + leaves payment --")
    sid2 = create_order([{"item_code": B, "qty": 2, "unit_price_idr": 50000}],
                        payment={"amount_idr": 100000, "method": "BCA"})
    o2_before = order_row(sid2)
    # also locks create_order's paid_idr seed on the FULL-paid path (CASE 1 covers the DP path)
    check("paid order starts Need send / Paid + paid_idr seeded at creation (100000)",
          o2_before["status"] == "Need send" and o2_before["payment_status"] == "Paid" and o2_before["paid_idr"] == 100000,
          str(o2_before))
    fulfill(sid2)
    sB_ff = stock(B)
    check("B available DOWN by 2 (fulfilled)", sB_ff["available"] == base[B]["available"] - 2,
          f'{base[B]["available"]}→{sB_ff["available"]}')
    check("B reserved UP by 2 (fulfilled)", sB_ff["reserved"] == base[B]["reserved"] + 2)
    lf = rest("GET", f"order_lines?sales_id=eq.{sid2}&select=courier,courier_speed,courier_label,courier_tracking")[0]
    check("courier fields stamped at fulfill", lf["courier"] == "JNE" and lf["courier_label"] == "JNE REG")

    aff = unfulfill(sid2)
    check("unfulfill returns affected codes", isinstance(aff, list) and B in aff, str(aff))
    sB_un = stock(B)
    check("B available RESTORED to baseline", sB_un["available"] == base[B]["available"],
          f'{sB_un["available"]} vs base {base[B]["available"]}')
    check("B reserved RESTORED to baseline", sB_un["reserved"] == base[B]["reserved"])
    lu = rest("GET", f"order_lines?sales_id=eq.{sid2}&select=fulfilled_at,courier,courier_speed,courier_label,courier_tracking")[0]
    check("line fulfilled_at cleared", lu["fulfilled_at"] is None)
    check("courier fields nulled on unfulfill",
          all(lu[k] is None for k in ("courier", "courier_speed", "courier_label", "courier_tracking")), str(lu))
    o2_after = order_row(sid2)
    check("payment UNTOUCHED by unfulfill (still Paid, paid_idr same)",
          o2_after["payment_status"] == "Paid" and o2_after["paid_idr"] == o2_before["paid_idr"], str(o2_after))
    check("order stays Need send (not flipped)", o2_after["status"] == "Need send", str(o2_after))

    # ── CASE 2b: holds are NOT re-created on unfulfill ──
    print("\n-- CASE 2b: unfulfill does NOT resurrect a released hold --")
    hold = rest("POST", "holds", body=[{"item_code": C, "qty": 1, "customer_id": cust_id, "note": "For: ORD SMOKE"}],
                prefer="return=representation")[0]
    created_holds.append(hold["hold_id"])
    s_held = stock(C)
    check("active hold lowered C available by 1", s_held["available"] == base[C]["available"] - 1,
          f'{base[C]["available"]}→{s_held["available"]}')
    sid3 = create_order([{"item_code": C, "qty": 1, "unit_price_idr": 50000}],
                        payment={"amount_idr": 50000, "method": "BCA"})
    fulfill(sid3)
    h_ff = rest("GET", f'holds?hold_id=eq.{hold["hold_id"]}&select=released_at')[0]
    check("hold auto-released on fulfill", h_ff["released_at"] is not None)

    unfulfill(sid3)
    h_un = rest("GET", f'holds?hold_id=eq.{hold["hold_id"]}&select=released_at')[0]
    sC_un = stock(C)
    check("hold STAYS released after unfulfill (not re-created)", h_un["released_at"] is not None,
          f'released_at={h_un["released_at"]}')
    check("C available FULLY restored to baseline (NOT base-1 — no hold resurrection)",
          sC_un["available"] == base[C]["available"],
          f'got {sC_un["available"]}, want {base[C]["available"]} (resurrection would be {base[C]["available"] - 1})')
    check("C reserved restored to baseline", sC_un["reserved"] == base[C]["reserved"])
    check("C on_hold back to baseline (hold gone)", sC_un["on_hold"] == base[C]["on_hold"])

finally:
    for sid in created_orders:
        try: rest("DELETE", f"orders?sales_id=eq.{sid}", prefer="return=minimal")
        except Exception as e: print("  cleanup order", sid, e)
    for hid in created_holds:
        try: rest("DELETE", f"holds?hold_id=eq.{hid}", prefer="return=minimal")
        except Exception as e: print("  cleanup hold", hid, e)
    if cust_id:
        try: rest("DELETE", f"customers?customer_id=eq.{cust_id}", prefer="return=minimal")
        except Exception as e: print("  cleanup customer", e)
    print("  (cleanup done)")

# zero-residual: every touched SKU back to baseline, and no test rows left
print("\n-- residual / restore check --")
try:
    for c in codes:
        s = stock(c)
        ok = all(s[k] == base[c][k] for k in ("available", "reserved", "physical", "on_hold"))
        check(f"{c} stock restored to baseline", ok, f"base={base[c]} now={s}")
    res_orders = rest("GET", f"orders?customer_id=eq.{cust_id}&select=sales_id") if cust_id else []
    res_cust = rest("GET", f"customers?phone=eq.{TEST_PHONE}&select=customer_id")
    check("no residual test orders", res_orders == [], str(res_orders))
    check("no residual test customer", res_cust == [], str(res_cust))
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
