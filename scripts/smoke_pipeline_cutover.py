#!/usr/bin/env python3
"""PR-B cutover smoke: exercise the new pipeline DB surface against the live DB, then clean up ALL test
rows and confirm every touched SKU returns to its pre-test baseline (zero residual). Uses the
service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER 0033 is applied.

  CASE 1 create_order RELAXED  : an order saved with address_id = null (SA-1 "confirm address later")
                                 → order + every line carry a null address_id.
  CASE 2 delete_pending_order  : a fully-uncut order is hard-deleted → order + lines + payments all gone.
  CASE 3 delete guard          : an order with a CUT line REFUSES delete_pending_order (raises).
  CASE 4 queue transitions     : cut (→ To-send: cut + courier-null) → set_fulfillment (→ Outbound:
                                 courier-not-null) → clear courier (Return-to-Fulfill: back to To-send)
                                 → unfulfill (Send-back-to-pending: uncut) — asserting the exact line
                                 predicates each screen's queue uses, plus the stock move on the cut.

  python3 scripts/smoke_pipeline_cutover.py
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
    r = rest("GET", f"stock_check?item_code=eq.{code}&select=available,reserved")
    return r[0] if r else {"available": 0, "reserved": 0}

def lines_of(sid, extra=""):
    return rest("GET", f"order_lines?sales_id=eq.{sid}&select=line_id,address_id,fulfilled_at,shipped_at,courier{extra}&order=line_id") or []

# the exact line predicates each screen's queue uses (mirrors the server actions)
def in_pending(l):   return l["fulfilled_at"] is None and l["shipped_at"] is None       # getPending
def in_to_send(l):   return l["fulfilled_at"] is not None and l["courier"] is None and l["shipped_at"] is None  # getToSendQueue
def in_outbound(l):  return l["fulfilled_at"] is not None and l["courier"] is not None and l["shipped_at"] is None  # getShipQueue (§6)

TEST_PHONE = "629990000005"
created_orders, cust_id, addr_id = [], None, None

def mk_order(lines, payment=None, with_address=True):
    payload = {"customer_id": cust_id, "lines": lines}
    if with_address:
        payload["address_id"] = addr_id
    if payment:
        payload["payment"] = payment
    sid = rest("POST", "rpc/create_order", body={"payload": payload})
    created_orders.append(sid)
    return sid

try:
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.1&order=item_code&limit=2")
    if len(skus) < 2:
        skus = rest("GET", "catalogue?select=item_code&order=item_code&limit=2")
        skus = [{"item_code": s["item_code"]} for s in skus]
    A, B = [s["item_code"] for s in skus]
    base = {A: stock(A), B: stock(B)}

    cust = rest("POST", "customers", body=[{"name": "CUT2 SMOKE", "phone": TEST_PHONE, "phone_raw": "cut2"}],
                prefer="return=representation")[0]
    cust_id = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust_id, "recipient_name": "CUT2",
                "raw_address": "Jl. Cutover 1"}], prefer="return=representation")[0]
    addr_id = addr["address_id"]

    # ── CASE 1: create_order saves a null-address order (SA-1) ──
    print("\n-- CASE 1: create_order relaxed (null address) --")
    sid1 = mk_order([{"item_code": A, "qty": 1, "unit_price_idr": 50000}], with_address=False)
    o1 = rest("GET", f"orders?sales_id=eq.{sid1}&select=address_id,status")[0]
    l1 = lines_of(sid1)
    check("order saved with null address_id (SA-1)", o1["address_id"] is None, f'address_id={o1["address_id"]}')
    check("line saved with null address_id", all(l["address_id"] is None for l in l1), str([l["address_id"] for l in l1]))
    check("uncut line is in the Pending predicate", all(in_pending(l) for l in l1))

    # ── CASE 2: delete_pending_order hard-deletes a fully-uncut order (cascade payments + lines) ──
    print("\n-- CASE 2: delete_pending_order (fully uncut → cascade) --")
    sid2 = mk_order([{"item_code": A, "qty": 1, "unit_price_idr": 80000}],
                    payment={"amount_idr": 30000, "method": "BCA"})
    pays_before = rest("GET", f"payments?sales_id=eq.{sid2}&select=amount_idr") or []
    check("DP order has a payments row", len(pays_before) == 1, str(pays_before))
    rest("POST", "rpc/delete_pending_order", body={"p_sales_id": sid2})
    created_orders.remove(sid2)
    gone_o = rest("GET", f"orders?sales_id=eq.{sid2}&select=sales_id")
    gone_l = rest("GET", f"order_lines?sales_id=eq.{sid2}&select=line_id")
    gone_p = rest("GET", f"payments?sales_id=eq.{sid2}&select=payment_id")
    check("order deleted", gone_o == [], str(gone_o))
    check("lines deleted (cascade)", gone_l == [], str(gone_l))
    check("payments deleted (cascade)", gone_p == [], str(gone_p))

    # ── CASE 3: delete_pending_order REFUSES an order with a cut line ──
    print("\n-- CASE 3: delete guard refuses a cut order --")
    sid3 = mk_order([{"item_code": A, "qty": 1, "unit_price_idr": 60000}])
    l3 = lines_of(sid3)
    rest("POST", "rpc/cut_order_lines", body={"p_sales_id": sid3, "p_line_ids": [l3[0]["line_id"]]})
    refused = False
    try:
        rest("POST", "rpc/delete_pending_order", body={"p_sales_id": sid3})
    except urllib.error.HTTPError as e:
        refused = True
        print(f"     (expected refusal: HTTP {e.code})")
    check("delete_pending_order RAISES on a cut order", refused)
    still = rest("GET", f"orders?sales_id=eq.{sid3}&select=sales_id")
    check("the cut order still exists (delete was refused)", len(still) == 1, str(still))
    rest("POST", "rpc/unfulfill_order", body={"p_sales_id": sid3})  # un-cut so the finally cleanup can delete it

    # ── CASE 4: cut → To-send → Outbound → back-to-To-send → Pending ──
    print("\n-- CASE 4: queue transitions --")
    sid4 = mk_order([{"item_code": B, "qty": 2, "unit_price_idr": 40000}])
    lid = lines_of(sid4)[0]["line_id"]
    # cut
    rest("POST", "rpc/cut_order_lines", body={"p_sales_id": sid4, "p_line_ids": [lid]})
    lc = lines_of(sid4)[0]
    sB = stock(B)
    check("after cut: in To-send (cut + courier null), NOT Outbound, NOT Pending",
          in_to_send(lc) and not in_outbound(lc) and not in_pending(lc), str(lc))
    check("after cut: B available DOWN by 2", sB["available"] == base[B]["available"] - 2,
          f'{base[B]["available"]}→{sB["available"]}')
    # set_fulfillment (Send to Outbound)
    rest("POST", "rpc/set_fulfillment", body={"p_sales_id": sid4, "p_line_ids": [lid], "p_address_id": addr_id,
         "p_courier": "JNE", "p_tracking": "TRK-CUT2", "p_courier_speed": "REG", "p_courier_label": "JNE REG"})
    lf = lines_of(sid4)[0]
    check("after set_fulfillment: in Outbound (courier set), NOT To-send",
          in_outbound(lf) and not in_to_send(lf), str(lf))
    check("set_fulfillment did not move stock again (still base-2)", stock(B)["available"] == base[B]["available"] - 2)
    # Return to Fulfill: clear courier (set_fulfillment with null courier, keep address)
    rest("POST", "rpc/set_fulfillment", body={"p_sales_id": sid4, "p_line_ids": [lid], "p_address_id": None,
         "p_courier": None, "p_tracking": None, "p_courier_speed": None, "p_courier_label": None})
    lr = lines_of(sid4)[0]
    check("Return-to-Fulfill: courier cleared → back to To-send; address kept; still cut",
          in_to_send(lr) and lr["address_id"] == addr_id and lr["fulfilled_at"] is not None, str(lr))
    # Send back to pending: unfulfill
    rest("POST", "rpc/unfulfill_order", body={"p_sales_id": sid4})
    lp = lines_of(sid4)[0]
    check("Send-back-to-pending: uncut → in Pending predicate", in_pending(lp), str(lp))
    check("after unfulfill: B available restored to baseline", stock(B)["available"] == base[B]["available"],
          f'{stock(B)["available"]} vs base {base[B]["available"]}')

finally:
    for sid in created_orders:
        try: rest("DELETE", f"orders?sales_id=eq.{sid}", prefer="return=minimal")
        except Exception as e: print("  cleanup order", sid, e)
    if cust_id:
        try: rest("DELETE", f"customers?customer_id=eq.{cust_id}", prefer="return=minimal")
        except Exception as e: print("  cleanup customer", e)
    print("  (cleanup done)")

print("\n-- residual / restore check --")
try:
    for c in (A, B):
        s = stock(c)
        ok = s["available"] == base[c]["available"] and s["reserved"] == base[c]["reserved"]
        check(f"{c} stock restored to baseline", ok, f"base={base[c]} now={s}")
    res_cust = rest("GET", f"customers?phone=eq.{TEST_PHONE}&select=customer_id")
    check("no residual test customer", res_cust == [], str(res_cust))
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
