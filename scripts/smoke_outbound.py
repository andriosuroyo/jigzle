#!/usr/bin/env python3
"""J2 Outbound smoke: exercise record_shipment against the live DB — full ship, partial ship,
server-recomputed box volumetric weight, and legacy-rows-untouched — asserting the stock_check
deltas (physical DOWN, reserved DOWN, available UNCHANGED), the Complete flip, the one-row-per-SKU
outbound_shipments + boxes under a send_id, then clean up ALL test rows and confirm zero residual.
Uses the service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER 0014.

  python3 scripts/smoke_outbound.py
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
FF = "2026-06-16T00:00:00Z"   # any non-null fulfilled_at (only not-null matters for stock)

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
def approx(a, b, eps=0.01):
    return a is not None and b is not None and abs(float(a) - float(b)) < eps

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
    r = rest("GET", f"stock_check?item_code=eq.{code}&select=available,physical,reserved")
    return r[0] if r else {"available": 0, "physical": 0, "reserved": 0}

TEST_PHONE = "629990000003"
cust_id = None
legacy = None

try:
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.10&order=item_code&limit=4")
    if len(skus) < 4:
        skus = [{"item_code": s["item_code"]} for s in rest("GET", "catalogue?select=item_code&order=item_code&limit=4")]
    A, B, C, D = [s["item_code"] for s in skus]
    base = {c: stock(c) for c in (A, B, C, D)}

    # legacy sample — a real imported outbound row (send_id NULL); must stay untouched
    legacy_rows = rest("GET", "outbound_shipments?send_id=is.null&select=shipment_id,sales_id,order_line_id,send_id,item_code,qty&limit=1")
    legacy = legacy_rows[0] if legacy_rows else None
    legacy_null_before = count_null = None
    def null_count():
        url = f"{db.base}/outbound_shipments?send_id=is.null&select=shipment_id"
        h = dict(db.h); h["Prefer"] = "count=exact"; h["Range-Unit"] = "items"; h["Range"] = "0-0"
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=db.timeout) as resp:
            cr = resp.headers.get("Content-Range", "")
        return int(cr.split("/")[-1]) if "/" in cr and cr.split("/")[-1].isdigit() else None
    legacy_null_before = null_count()

    cust = rest("POST", "customers", body=[{"name": "OB SMOKE", "phone": TEST_PHONE, "phone_raw": "ob"}],
                prefer="return=representation")[0]
    cust_id = cust["customer_id"]
    addr = rest("POST", "customer_addresses", body=[{"customer_id": cust_id, "recipient_name": "OB",
                "raw_address": "Jl. Outbound 5, Balikpapan"}], prefer="return=representation")[0]
    addr_id = addr["address_id"]

    def mk_fulfilled_order(sid, lines):
        rest("POST", "orders", body=[{"sales_id": sid, "customer_id": cust_id, "address_id": addr_id,
              "status": "Need send", "payment_status": "Paid"}], prefer="return=minimal")
        rows = [{"line_id": f"{sid}-{i+1}", "sales_id": sid, "item_code": c, "qty": q,
                 "fulfilled_at": FF, "is_cancelled": False, "address_id": addr_id}
                for i, (c, q) in enumerate(lines)]
        rest("POST", "order_lines", body=rows, prefer="return=minimal")
        return [r["line_id"] for r in rows]

    def ship(sid, line_ids, courier, tracking, boxes):
        return rest("POST", "rpc/record_shipment", body={"p_sales_id": sid, "p_line_ids": line_ids,
                    "p_courier": courier, "p_tracking": tracking, "p_boxes": boxes})

    # ── CASE 1: full ship (A×1, B×2) with two boxes (volumetric recompute) ──
    print("\n-- CASE 1: full ship + box volumetric --")
    l1 = mk_fulfilled_order("ZZ-OBTEST-1", [(A, 1), (B, 2)])
    preA, preB = stock(A), stock(B)   # fulfilled-but-unshipped state
    boxes = [
        {"real_weight": 10, "dim_p": 100, "dim_l": 100, "dim_t": 100, "bill_by_volume": True, "chargeable_weight": 99999},
        {"real_weight": 50, "dim_p": 10, "dim_l": 10, "dim_t": 10, "bill_by_volume": False, "chargeable_weight": 99999},
    ]
    aff = ship("ZZ-OBTEST-1", l1, "JNE", "TRK-1", boxes)
    check("record_shipment returned affected codes", isinstance(aff, list) and A in aff and B in aff, str(aff))
    la = rest("GET", "order_lines?line_id=eq.ZZ-OBTEST-1-1&select=shipped_at,courier,courier_tracking")[0]
    check("line A shipped_at set", la["shipped_at"] is not None)
    check("line A courier/tracking persisted", la["courier"] == "JNE" and la["courier_tracking"] == "TRK-1")
    postA, postB = stock(A), stock(B)
    check("A physical DOWN by 1", postA["physical"] == preA["physical"] - 1, f'{preA["physical"]}→{postA["physical"]}')
    check("A reserved DOWN by 1", postA["reserved"] == preA["reserved"] - 1)
    check("A available UNCHANGED (moved at fulfill)", postA["available"] == preA["available"])
    check("B physical DOWN by 2", postB["physical"] == preB["physical"] - 2)
    check("B reserved DOWN by 2", postB["reserved"] == preB["reserved"] - 2)
    check("B available UNCHANGED", postB["available"] == preB["available"])
    o1 = rest("GET", "orders?sales_id=eq.ZZ-OBTEST-1&select=status")[0]
    check("order → Complete (all lines shipped)", o1["status"] == "Complete", o1["status"])
    obs = rest("GET", "outbound_shipments?sales_id=eq.ZZ-OBTEST-1&select=order_line_id,send_id,item_code,qty&order=order_line_id")
    check("one outbound_shipments row per shipped line", len(obs) == 2, str(len(obs)))
    check("outbound rows carry order_line_id + send_id", all(r["order_line_id"] and r["send_id"] for r in obs))
    send_id = obs[0]["send_id"] if obs else None
    check("both outbound rows share one send_id", send_id and all(r["send_id"] == send_id for r in obs))
    bx = rest("GET", f"boxes?send_id=eq.{send_id}&select=real_weight,dim_p,vol_weight,chargeable_weight&order=box_id")
    check("boxes written under the send_id", len(bx) == 2, str(len(bx)))
    if len(bx) == 2:
        b1 = next(b for b in bx if approx(b["real_weight"], 10))
        b2 = next(b for b in bx if approx(b["real_weight"], 50))
        check("box1 vol = ceil·ceil·ceil/6000 (≈166.67)", approx(b1["vol_weight"], 1000000 / 6000))
        check("box1 chargeable = vol (vol>real), NOT the client 99999", approx(b1["chargeable_weight"], 1000000 / 6000))
        check("box2 chargeable = real (real>vol), NOT 99999", approx(b2["chargeable_weight"], 50))

    # ── CASE 2: partial ship (C, D fulfilled; ship only C) ──
    print("\n-- CASE 2: partial ship --")
    l2 = mk_fulfilled_order("ZZ-OBTEST-2", [(C, 1), (D, 1)])
    preC, preD = stock(C), stock(D)
    ship("ZZ-OBTEST-2", [l2[0]], "J&T", None, [])
    lc = rest("GET", "order_lines?line_id=eq.ZZ-OBTEST-2-1&select=shipped_at")[0]
    ld = rest("GET", "order_lines?line_id=eq.ZZ-OBTEST-2-2&select=shipped_at")[0]
    o2 = rest("GET", "orders?sales_id=eq.ZZ-OBTEST-2&select=status")[0]
    check("line C shipped", lc["shipped_at"] is not None)
    check("line D still unshipped (partial)", ld["shipped_at"] is None)
    check("order NOT Complete (a line remains)", o2["status"] != "Complete", o2["status"])
    postC, postD = stock(C), stock(D)
    check("C physical DOWN by 1", postC["physical"] == preC["physical"] - 1)
    check("C reserved DOWN by 1", postC["reserved"] == preC["reserved"] - 1)
    check("C available UNCHANGED", postC["available"] == preC["available"])
    check("D untouched (physical/reserved/available)",
          postD == preD, f"pre={preD} post={postD}")
    q = rest("GET", "orders?sales_id=eq.ZZ-OBTEST-2&select=sales_id,order_lines!inner(line_id)"
                    "&order_lines.shipped_at=is.null&order_lines.fulfilled_at=not.is.null&order_lines.is_cancelled=is.false")
    check("order stays in ship queue with the remaining line", bool(q) and len(q[0]["order_lines"]) == 1, str(q))

    # ── CASE 3: legacy outbound rows untouched ──
    print("\n-- CASE 3: legacy rows untouched --")
    if legacy:
        now = rest("GET", f"outbound_shipments?shipment_id=eq.{legacy['shipment_id']}"
                          "&select=shipment_id,sales_id,order_line_id,send_id,item_code,qty")[0]
        check("legacy row still has send_id/sales_id/order_line_id NULL",
              now["send_id"] is None and now["sales_id"] is None and now["order_line_id"] is None)
        check("legacy row item_code/qty unchanged", now["item_code"] == legacy["item_code"] and now["qty"] == legacy["qty"])
    else:
        check("legacy sample present", False, "no legacy send_id-NULL row found")

finally:
    # cleanup — boxes (by test send_id) → outbound_shipments → orders (cascade lines) → customer
    try:
        test_obs = rest("GET", "outbound_shipments?sales_id=like.ZZ-OBTEST-*&select=send_id")
        sends = sorted({r["send_id"] for r in (test_obs or []) if r["send_id"]})
        for sd in sends:
            rest("DELETE", f"boxes?send_id=eq.{sd}", prefer="return=minimal")
        rest("DELETE", "outbound_shipments?sales_id=like.ZZ-OBTEST-*", prefer="return=minimal")
        rest("DELETE", "orders?sales_id=like.ZZ-OBTEST-*", prefer="return=minimal")
        if cust_id:
            rest("DELETE", f"customers?customer_id=eq.{cust_id}", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

# zero-residual + legacy count restored
print("\n-- residual / restore check --")
try:
    for c in (A, B, C, D):
        s = stock(c)
        ok = all(s[k] == base[c][k] for k in ("available", "physical", "reserved"))
        check(f"{c} stock restored to baseline", ok, f"base={base[c]} now={s}")
    check("no residual test outbound_shipments", rest("GET", "outbound_shipments?sales_id=like.ZZ-OBTEST-*&select=shipment_id") == [])
    check("no residual test orders", rest("GET", "orders?sales_id=like.ZZ-OBTEST-*&select=sales_id") == [])
    check("legacy send_id-NULL count unchanged", null_count() == legacy_null_before, f"{legacy_null_before} → {null_count()}")
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
