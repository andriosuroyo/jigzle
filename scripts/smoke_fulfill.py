#!/usr/bin/env python3
"""J2 Fulfill smoke: exercise fulfill_order against the live DB — full fulfill, partial,
the hold-netting case, and short-stock — asserting the stock_check deltas, then clean up
ALL test rows and confirm every touched SKU returns to its pre-test baseline (zero residual).
Uses the service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER
0013 is applied.

  python3 scripts/smoke_fulfill.py
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

TEST_PHONE = "629990000002"
TODAY = None
created_orders, created_holds = [], []
cust_id = None

try:
    # seven distinct SKUs with small available so the short-stock qty stays sane
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.10&order=item_code&limit=7")
    if len(skus) < 7:
        skus = rest("GET", "catalogue?select=item_code&order=item_code&limit=7")
        skus = [{"item_code": s["item_code"]} for s in skus]
    codes = [s["item_code"] for s in skus]
    A, B, C, D, E, F, G = codes
    base = {c: stock(c) for c in codes}     # pre-test baselines (capture BEFORE any mutation)

    # test customer + address
    cust = rest("POST", "customers", body=[{"name": "FF SMOKE", "phone": TEST_PHONE, "phone_raw": "ff"}],
                prefer="return=representation")[0]
    cust_id = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust_id, "recipient_name": "FF",
                "raw_address": "Jl. Fulfill 1"}], prefer="return=representation")[0]
    addr_id = addr["address_id"]

    def mk_order(sid, lines):
        rest("POST", "orders", body=[{"sales_id": sid, "customer_id": cust_id, "address_id": addr_id,
              "status": "Need send", "payment_status": "Paid"}], prefer="return=minimal")
        created_orders.append(sid)
        rows = [{"line_id": f"{sid}-{i+1}", "sales_id": sid, "item_code": c, "qty": q,
                 "is_cancelled": False} for i, (c, q) in enumerate(lines)]
        rest("POST", "order_lines", body=rows, prefer="return=minimal")
        return [r["line_id"] for r in rows]

    def fulfill(sid, line_ids):
        # PR26 (0029): fulfill_order is now 7-arg — courier_speed + courier_label travel on the line.
        return rest("POST", "rpc/fulfill_order", body={"p_sales_id": sid, "p_line_ids": line_ids,
                    "p_address_id": addr_id, "p_courier": "JNE", "p_tracking": None,
                    "p_courier_speed": None, "p_courier_label": "JNE"})

    # ── CASE 1: full fulfill of an in-stock order (A×1, B×2) ──
    print("\n-- CASE 1: full fulfill --")
    l1 = mk_order("ZZ-FFTEST-1", [(A, 1), (B, 2)])
    s_after_insert = stock(A)
    check("inserting unfulfilled lines does NOT move stock (D2)",
          s_after_insert["available"] == base[A]["available"], f'{s_after_insert["available"]} == {base[A]["available"]}')
    fulfill("ZZ-FFTEST-1", l1)
    la = rest("GET", "order_lines?line_id=eq.ZZ-FFTEST-1-1&select=fulfilled_at,shipped_at,courier")[0]
    check("line A fulfilled_at set", la["fulfilled_at"] is not None)
    check("line A shipped_at still NULL (no ship at fulfill)", la["shipped_at"] is None)
    check("line A courier persisted", la["courier"] == "JNE")
    sA, sB = stock(A), stock(B)
    check("A available DOWN by 1", sA["available"] == base[A]["available"] - 1, f'{base[A]["available"]}→{sA["available"]}')
    check("A reserved UP by 1", sA["reserved"] == base[A]["reserved"] + 1)
    check("A physical unchanged", sA["physical"] == base[A]["physical"])
    check("B available DOWN by 2", sB["available"] == base[B]["available"] - 2)
    check("B reserved UP by 2", sB["reserved"] == base[B]["reserved"] + 2)
    check("B physical unchanged", sB["physical"] == base[B]["physical"])

    # ── CASE 2: partial fulfill (C×1, D×1; fulfill only C) ──
    print("\n-- CASE 2: partial fulfill --")
    l2 = mk_order("ZZ-FFTEST-2", [(C, 1), (D, 1)])
    fulfill("ZZ-FFTEST-2", [l2[0]])  # only line C
    lc = rest("GET", "order_lines?line_id=eq.ZZ-FFTEST-2-1&select=fulfilled_at")[0]
    ld = rest("GET", "order_lines?line_id=eq.ZZ-FFTEST-2-2&select=fulfilled_at")[0]
    check("line C fulfilled", lc["fulfilled_at"] is not None)
    check("line D still unfulfilled (partial)", ld["fulfilled_at"] is None)
    # stock moved for C only; D must be untouched (proves only the selected line was stamped)
    sC, sD = stock(C), stock(D)
    check("C available DOWN by 1", sC["available"] == base[C]["available"] - 1, f'{base[C]["available"]}→{sC["available"]}')
    check("C reserved UP by 1", sC["reserved"] == base[C]["reserved"] + 1)
    check("C physical unchanged", sC["physical"] == base[C]["physical"])
    check("D untouched: available unchanged", sD["available"] == base[D]["available"])
    check("D untouched: reserved unchanged", sD["reserved"] == base[D]["reserved"])
    # the order still surfaces in the fulfill queue (the exact getFulfillQueue PostgREST query)
    q = rest("GET", "orders?sales_id=eq.ZZ-FFTEST-2&status=eq.Need%20send"
                    "&select=sales_id,order_lines!inner(line_id)"
                    "&order_lines.fulfilled_at=is.null&order_lines.is_cancelled=is.false")
    check("order stays in queue with the remaining line", bool(q) and len(q[0]["order_lines"]) == 1, str(q))

    # ── CASE 3: hold netting (E×2 with an active hold of 2 for this customer) ──
    print("\n-- CASE 3: hold auto-release netting --")
    hold = rest("POST", "holds", body=[{"item_code": E, "qty": 2, "customer_id": cust_id,
                "note": "For: FF SMOKE"}], prefer="return=representation")[0]
    created_holds.append(hold["hold_id"])
    s_held = stock(E)
    check("active hold lowered available by 2", s_held["available"] == base[E]["available"] - 2,
          f'{base[E]["available"]}→{s_held["available"]}')
    l3 = mk_order("ZZ-FFTEST-3", [(E, 2)])
    fulfill("ZZ-FFTEST-3", l3)
    h_after = rest("GET", f'holds?hold_id=eq.{hold["hold_id"]}&select=released_at')[0]
    sE = stock(E)
    check("hold auto-released on fulfill", h_after["released_at"] is not None)
    check("available NETS to base-2 (no double count)", sE["available"] == base[E]["available"] - 2,
          f'got {sE["available"]}, want {base[E]["available"] - 2} (double-count would be {base[E]["available"] - 4})')
    check("E reserved UP by 2 (fulfill reservation)", sE["reserved"] == base[E]["reserved"] + 2)
    check("E on_hold back to baseline", sE["on_hold"] == base[E]["on_hold"])

    # ── CASE 3b: hold CAP — two holds (2+2) on G, fulfill only 2. The over-release guard
    #    must release ONLY the oldest hold (2), leave the newer one active, and NOT credit
    #    available for the un-fulfilled 2. Without the cap, both would release (base-2,
    #    on_hold base); with the cap, available stays base-4 and one hold survives. ──
    print("\n-- CASE 3b: hold over-release cap --")
    h1 = rest("POST", "holds", body=[{"item_code": G, "qty": 2, "customer_id": cust_id, "note": "hold1"}],
              prefer="return=representation")[0]
    created_holds.append(h1["hold_id"])
    h2 = rest("POST", "holds", body=[{"item_code": G, "qty": 2, "customer_id": cust_id, "note": "hold2"}],
              prefer="return=representation")[0]
    created_holds.append(h2["hold_id"])
    s_held2 = stock(G)
    check("two holds lowered available by 4", s_held2["available"] == base[G]["available"] - 4,
          f'{base[G]["available"]}→{s_held2["available"]}')
    l3b = mk_order("ZZ-FFTEST-5", [(G, 2)])
    fulfill("ZZ-FFTEST-5", l3b)
    h1a = rest("GET", f'holds?hold_id=eq.{h1["hold_id"]}&select=released_at')[0]
    h2a = rest("GET", f'holds?hold_id=eq.{h2["hold_id"]}&select=released_at')[0]
    sG = stock(G)
    check("cap: ONLY the oldest hold released (newer stays active)",
          h1a["released_at"] is not None and h2a["released_at"] is None,
          f'h1={h1a["released_at"]}, h2={h2a["released_at"]}')
    check("cap: available stays base-4 (NOT base-2 — no over-release)",
          sG["available"] == base[G]["available"] - 4, f'got {sG["available"]}, want {base[G]["available"] - 4}')
    check("cap: on_hold dropped by only 2 (one hold of 2 survives)", sG["on_hold"] == base[G]["on_hold"] + 2)
    check("G reserved UP by 2", sG["reserved"] == base[G]["reserved"] + 2)

    # ── CASE 4: short-stock fulfill (F qty > available → available goes negative) ──
    print("\n-- CASE 4: short stock --")
    qtyF = (base[F]["available"] if base[F]["available"] > 0 else 0) + 2
    l4 = mk_order("ZZ-FFTEST-4", [(F, qtyF)])
    aff = fulfill("ZZ-FFTEST-4", l4)
    sF = stock(F)
    check("short-stock fulfill succeeds (returns affected codes)", isinstance(aff, list) and F in aff, str(aff))
    check("F available went negative", sF["available"] < 0, f'{base[F]["available"]} − {qtyF} = {sF["available"]}')
    check("F available == base − qty exactly", sF["available"] == base[F]["available"] - qtyF)

finally:
    # cleanup — orders (cascades lines/payments), then holds, then customer (cascades address)
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

# zero-residual: every touched SKU back to its pre-test baseline, and no test rows left
print("\n-- residual / restore check --")
try:
    for c in codes:
        s = stock(c)
        ok = all(s[k] == base[c][k] for k in ("available", "reserved", "physical", "on_hold"))
        check(f"{c} stock restored to baseline", ok, f"base={base[c]} now={s}")
    res_orders = rest("GET", "orders?sales_id=like.ZZ-FFTEST-*&select=sales_id")
    res_cust = rest("GET", f"customers?phone=eq.{TEST_PHONE}&select=customer_id")
    check("no residual test orders", res_orders == [], str(res_orders))
    check("no residual test customer", res_cust == [], str(res_cust))
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
