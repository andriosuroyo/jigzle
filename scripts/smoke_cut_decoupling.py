#!/usr/bin/env python3
"""PR-A cut-decoupling smoke: exercise cut_order_lines + set_fulfillment against the live DB, plus
unfulfill_order / fulfill_order regressions, then clean up ALL test rows and confirm every touched
SKU returns to its pre-test baseline (zero residual). Uses the service-role key as a TEST HARNESS
only (the app uses anon + session). Run AFTER 0032 is applied.

  CASE 1  cut_order_lines : a fresh order, in-stock lines, with a pre-created matching hold. After the
                            cut: fulfilled_at set; courier/courier_speed/courier_label/courier_tracking
                            AND address_id still NULL (decoupled); available↓ / reserved↑; the matching
                            hold released (capped per item_code). An uncut control line stays untouched.
  CASE 2  set_fulfillment : on those cut lines → the four courier fields + address_id set, and
                            stock_check UNCHANGED vs right after the cut (no second stock move). The
                            uncut control line is skipped (the `fulfilled_at is not null` guard).
  CASE 3  unfulfill_order : reverses a cut+set line (clears fulfilled_at + courier fields, restores
                            stock) — regression that the untouched RPC still works post-split.
  CASE 4  fulfill_order   : still works end-to-end (cut + courier/address in one call) — regression.

  python3 scripts/smoke_cut_decoupling.py
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

def same_stock(a, b):
    return all(a[k] == b[k] for k in ("available", "reserved", "physical", "on_hold"))

COURIER_FIELDS = ("courier", "courier_speed", "courier_label", "courier_tracking")
def line_row(line_id):
    sel = "fulfilled_at,shipped_at,address_id," + ",".join(COURIER_FIELDS)
    return rest("GET", f"order_lines?line_id=eq.{line_id}&select={sel}")[0]

TEST_PHONE = "629990000004"
created_orders, created_holds = [], []
cust_id = None
addr_id = None

try:
    # five distinct in-stock SKUs so each case is independent against the global baseline
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.10&order=item_code&limit=5")
    if len(skus) < 5:
        skus = rest("GET", "catalogue?select=item_code&order=item_code&limit=5")
        skus = [{"item_code": s["item_code"]} for s in skus]
    codes = [s["item_code"] for s in skus]
    A, B, C, D, E = codes
    base = {c: stock(c) for c in codes}     # pre-test baselines (capture BEFORE any mutation)

    cust = rest("POST", "customers", body=[{"name": "CUT SMOKE", "phone": TEST_PHONE, "phone_raw": "cut"}],
                prefer="return=representation")[0]
    cust_id = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust_id, "recipient_name": "CUT",
                "raw_address": "Jl. Cut 1"}], prefer="return=representation")[0]
    addr_id = addr["address_id"]

    def mk_order(sid, lines):
        # Direct insert (NOT create_order) so order_lines.address_id starts NULL — that lets CASE 1
        # prove cut_order_lines leaves address_id null, and CASE 2 prove set_fulfillment sets it.
        rest("POST", "orders", body=[{"sales_id": sid, "customer_id": cust_id, "address_id": addr_id,
              "status": "Need send", "payment_status": "Paid"}], prefer="return=minimal")
        created_orders.append(sid)
        rows = [{"line_id": f"{sid}-{i+1}", "sales_id": sid, "item_code": c, "qty": q,
                 "is_cancelled": False} for i, (c, q) in enumerate(lines)]
        rest("POST", "order_lines", body=rows, prefer="return=minimal")
        return [r["line_id"] for r in rows]

    def cut(sid, line_ids):
        return rest("POST", "rpc/cut_order_lines", body={"p_sales_id": sid, "p_line_ids": line_ids})

    def set_fulfillment(sid, line_ids):
        return rest("POST", "rpc/set_fulfillment", body={"p_sales_id": sid, "p_line_ids": line_ids,
                    "p_address_id": addr_id, "p_courier": "JNE", "p_tracking": "TRK-CUT",
                    "p_courier_speed": "REG", "p_courier_label": "JNE REG"})

    def fulfill(sid, line_ids):
        return rest("POST", "rpc/fulfill_order", body={"p_sales_id": sid, "p_line_ids": line_ids,
                    "p_address_id": addr_id, "p_courier": "JNE", "p_tracking": "TRK-FF",
                    "p_courier_speed": "REG", "p_courier_label": "JNE REG"})

    def unfulfill(sid):
        return rest("POST", "rpc/unfulfill_order", body={"p_sales_id": sid})

    # ── CASE 1: cut_order_lines — cut only, no courier/address; hold released ──
    print("\n-- CASE 1: cut_order_lines (cut only, no courier/address) --")
    # pre-create a matching hold on B for this customer (qty == the line qty we'll cut)
    hold = rest("POST", "holds", body=[{"item_code": B, "qty": 2, "customer_id": cust_id, "note": "For: CUT SMOKE"}],
                prefer="return=representation")[0]
    created_holds.append(hold["hold_id"])
    s_held = stock(B)
    check("active hold lowered B available by 2", s_held["available"] == base[B]["available"] - 2,
          f'{base[B]["available"]}→{s_held["available"]}')

    # A = clean cut, B = cut with matching hold (netting), C = control line we DON'T cut
    l1 = mk_order("ZZ-CUTTEST-1", [(A, 2), (B, 2), (C, 1)])
    lA, lB, lC = l1
    aff = cut("ZZ-CUTTEST-1", [lA, lB])     # cut A and B only — leave C uncut
    check("cut_order_lines returns affected codes (A, B)",
          isinstance(aff, list) and set(aff) == {A, B}, str(aff))

    rA, rB, rC = line_row(lA), line_row(lB), line_row(lC)
    check("line A fulfilled_at set", rA["fulfilled_at"] is not None)
    check("line A shipped_at still NULL", rA["shipped_at"] is None)
    check("line A courier fields ALL still NULL (decoupled)",
          all(rA[k] is None for k in COURIER_FIELDS), str({k: rA[k] for k in COURIER_FIELDS}))
    check("line A address_id still NULL (decoupled)", rA["address_id"] is None, str(rA["address_id"]))
    check("line B fulfilled_at set + courier/address NULL",
          rB["fulfilled_at"] is not None and rB["address_id"] is None
          and all(rB[k] is None for k in COURIER_FIELDS), str(rB))
    check("control line C NOT cut (fulfilled_at NULL)", rC["fulfilled_at"] is None, str(rC["fulfilled_at"]))

    sA, sB, sC = stock(A), stock(B), stock(C)
    check("A available DOWN by 2 (cut)", sA["available"] == base[A]["available"] - 2,
          f'{base[A]["available"]}→{sA["available"]}')
    check("A reserved UP by 2 (cut)", sA["reserved"] == base[A]["reserved"] + 2)
    check("A physical unchanged", sA["physical"] == base[A]["physical"])
    h_after = rest("GET", f'holds?hold_id=eq.{hold["hold_id"]}&select=released_at')[0]
    check("matching hold on B auto-released by cut", h_after["released_at"] is not None)
    check("B available NETS to base-2 (hold released, no double count)",
          sB["available"] == base[B]["available"] - 2,
          f'got {sB["available"]}, want {base[B]["available"] - 2} (double-count would be {base[B]["available"] - 4})')
    check("B reserved UP by 2 (cut)", sB["reserved"] == base[B]["reserved"] + 2)
    check("B on_hold back to baseline (hold gone)", sB["on_hold"] == base[B]["on_hold"])
    check("control C stock untouched by the cut", same_stock(sC, base[C]), f"base={base[C]} now={sC}")

    # snapshot stock right after the cut — CASE 2 must leave these EXACTLY unchanged
    sA_cut, sB_cut, sC_cut = sA, sB, sC

    # ── CASE 2: set_fulfillment — courier/address on cut lines, NO stock move ──
    print("\n-- CASE 2: set_fulfillment (courier/address, no stock move) --")
    # pass the uncut control line C too: the `fulfilled_at is not null` guard must SKIP it
    set_fulfillment("ZZ-CUTTEST-1", [lA, lB, lC])
    rA2, rB2, rC2 = line_row(lA), line_row(lB), line_row(lC)
    check("line A courier fields all set",
          rA2["courier"] == "JNE" and rA2["courier_speed"] == "REG"
          and rA2["courier_label"] == "JNE REG" and rA2["courier_tracking"] == "TRK-CUT", str(rA2))
    check("line A address_id set", rA2["address_id"] == addr_id, str(rA2["address_id"]))
    check("line B courier fields + address set",
          rB2["courier"] == "JNE" and rB2["courier_label"] == "JNE REG" and rB2["address_id"] == addr_id, str(rB2))
    check("uncut control C left untouched (courier + address still NULL)",
          rC2["address_id"] is None and all(rC2[k] is None for k in COURIER_FIELDS), str(rC2))

    sA2, sB2, sC2 = stock(A), stock(B), stock(C)
    check("A stock UNCHANGED by set_fulfillment", same_stock(sA2, sA_cut), f"cut={sA_cut} now={sA2}")
    check("B stock UNCHANGED by set_fulfillment", same_stock(sB2, sB_cut), f"cut={sB_cut} now={sB2}")
    check("C stock UNCHANGED by set_fulfillment", same_stock(sC2, sC_cut), f"cut={sC_cut} now={sC2}")

    # ── CASE 3: unfulfill_order regression on a cut+set line ──
    print("\n-- CASE 3: unfulfill_order regression (cut + set, then reverse) --")
    l3 = mk_order("ZZ-CUTTEST-2", [(D, 1)])
    cut("ZZ-CUTTEST-2", l3)
    set_fulfillment("ZZ-CUTTEST-2", l3)
    sD_ff = stock(D)
    check("D available DOWN by 1 after cut+set", sD_ff["available"] == base[D]["available"] - 1,
          f'{base[D]["available"]}→{sD_ff["available"]}')
    rD = line_row(l3[0])
    check("D line fulfilled + courier set (pre-unfulfill)",
          rD["fulfilled_at"] is not None and rD["courier"] == "JNE", str(rD))

    affu = unfulfill("ZZ-CUTTEST-2")
    check("unfulfill returns affected codes (D)", isinstance(affu, list) and D in affu, str(affu))
    rDu = line_row(l3[0])
    sD_un = stock(D)
    check("D line fulfilled_at cleared", rDu["fulfilled_at"] is None)
    check("D courier fields nulled on unfulfill", all(rDu[k] is None for k in COURIER_FIELDS), str(rDu))
    check("D available RESTORED to baseline", sD_un["available"] == base[D]["available"],
          f'{sD_un["available"]} vs base {base[D]["available"]}')
    check("D reserved RESTORED to baseline", sD_un["reserved"] == base[D]["reserved"])

    # ── CASE 4: fulfill_order regression — cut + courier/address in one call ──
    print("\n-- CASE 4: fulfill_order regression (one-call cut + courier/address) --")
    l4 = mk_order("ZZ-CUTTEST-3", [(E, 1)])
    afff = fulfill("ZZ-CUTTEST-3", l4)
    check("fulfill_order returns affected codes (E)", isinstance(afff, list) and E in afff, str(afff))
    rE = line_row(l4[0])
    check("E line fulfilled + courier + address set in one call",
          rE["fulfilled_at"] is not None and rE["courier"] == "JNE"
          and rE["courier_label"] == "JNE REG" and rE["address_id"] == addr_id, str(rE))
    sE = stock(E)
    check("E available DOWN by 1 (fulfill_order still moves stock)", sE["available"] == base[E]["available"] - 1,
          f'{base[E]["available"]}→{sE["available"]}')
    check("E reserved UP by 1", sE["reserved"] == base[E]["reserved"] + 1)

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
    res_orders = rest("GET", "orders?sales_id=like.ZZ-CUTTEST-*&select=sales_id")
    res_cust = rest("GET", f"customers?phone=eq.{TEST_PHONE}&select=customer_id")
    check("no residual test orders", res_orders == [], str(res_orders))
    check("no residual test customer", res_cust == [], str(res_cust))
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
