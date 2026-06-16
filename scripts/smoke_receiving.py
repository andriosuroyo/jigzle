#!/usr/bin/env python3
"""J2 Receiving smoke: exercise record_receipt + next_adhoc_ship_id against the live DB —
full receive (+ close + D4 PO mark), partial receive (stays open), an excluded line (adds 0),
a signed negative correction, the barcode-collision resolve pattern (D1), an unknown-barcode
needs_review stub (D2), the 📦YYMMXXX allocator, and the fail-loud on an unknown item_code —
asserting the stock_check deltas (available/physical UP by qty, last_receive = receive_date),
then clean up ALL test rows and confirm every touched SKU is back to its pre-test baseline.
Uses the service-role key as a TEST HARNESS only (the app uses anon + session). Run AFTER 0015.

  python3 scripts/smoke_receiving.py
"""
import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "import"))
from db import Client, load_env  # noqa: E402

env = load_env()
db = Client(env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY"))
db.ping()

# receive_date = today (Asia/Jakarta) — last_receive becomes max(prior, R)
JKT = datetime.now(timezone.utc) + timedelta(hours=7)
R = JKT.strftime("%Y-%m-%d")
PERIOD = JKT.strftime("%y%m")

PASS, FAIL = [], []
def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")

def rest(method, path, body=None, prefer=None, raw_ok=True):
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
    r = rest("GET", f"stock_check?item_code=eq.{code}&select=available,physical,last_receive")
    return r[0] if r else {"available": 0, "physical": 0, "last_receive": None}

def expected_last_receive(prior):
    # last_receive = max(prior, R); dates compare lexically in ISO form
    return R if (prior is None or prior <= R) else prior

def receipt(ship_id, lines, close):
    return rest("POST", "rpc/record_receipt", body={
        "p_ship_id": ship_id, "p_receive_date": R, "p_lines": lines, "p_close_shipment": close})

# test ship-id prefix (all test inbound/shipments/POs share it → single-prefix cleanup)
SHIP1 = "ZZ-RCV-SHIP1"
SHIP2 = "ZZ-RCV-SHIP2"
ADHOC = "ZZ-RCV-ADHOC"
STUB_CODE = "ZZ-RCV-STUB-001"
BC_COLLIDE = "ZZRCVBC_COLLIDE"
BC_UNKNOWN = "ZZRCVBC_UNKNOWN"

def cleanup():
    try:
        rest("DELETE", "inbound?ship_id=like.ZZ-RCV-*", prefer="return=minimal")
        for bc in (BC_COLLIDE, f"{BC_COLLIDE}#2", BC_UNKNOWN):
            rest("DELETE", f"barcodes?barcode=eq.{urllib.parse.quote(bc)}", prefer="return=minimal")
        rest("DELETE", f"catalogue?item_code=eq.{STUB_CODE}", prefer="return=minimal")
        rest("DELETE", "purchase_orders?ship_id=like.ZZ-RCV-*", prefer="return=minimal")
        rest("DELETE", "shipments?ship_id=like.ZZ-RCV-*", prefer="return=minimal")
        print("  (cleanup done)")
    except Exception as e:
        print("  cleanup error:", e)

import urllib.parse  # noqa: E402

base = {}
try:
    cleanup()  # start clean in case a prior run aborted

    # four real SKUs with small available
    skus = rest("GET", "stock_check?select=item_code,available&available=gte.0&available=lte.20&order=item_code&limit=4")
    if len(skus) < 4:
        skus = [{"item_code": s["item_code"]} for s in rest("GET", "catalogue?select=item_code&order=item_code&limit=4")]
    A, B, C, D = [s["item_code"] for s in skus]
    base = {c: stock(c) for c in (A, B, C, D)}

    # ── CASE 1: full receive + close + D4 PO mark ──
    print("\n-- CASE 1: full receive (+ close + D4) --")
    rest("POST", "shipments", body=[{"ship_id": SHIP1, "origin_country": "China", "status": "open",
         "ship_date": "2026-06-01", "tracking": "TRK-RCV-1", "contents": [{"qty": 2, "item": A}, {"qty": 3, "item": B}]}],
         prefer="return=minimal")
    rest("POST", "purchase_orders", body=[{"item_code": A, "qty": 2, "status": "On the way", "ship_id": SHIP1}],
         prefer="return=minimal")
    aff = receipt(SHIP1, [{"item_code": A, "qty": 2, "excluded": False},
                          {"item_code": B, "qty": 3, "excluded": False}], True)
    check("record_receipt returned affected codes", isinstance(aff, list) and A in aff and B in aff, str(aff))
    inb = rest("GET", f"inbound?ship_id=eq.{SHIP1}&select=item_code,qty,receive_date,tracking,excluded&order=item_code")
    check("two inbound rows written", len(inb) == 2, str(len(inb)))
    check("inbound carries ship tracking + receive_date", all(r["tracking"] == "TRK-RCV-1" and r["receive_date"] == R for r in inb))
    sA, sB = stock(A), stock(B)
    check("A available UP by 2", sA["available"] == base[A]["available"] + 2, f'{base[A]["available"]}→{sA["available"]}')
    check("A physical UP by 2", sA["physical"] == base[A]["physical"] + 2)
    check("A last_receive = receive_date", sA["last_receive"] == expected_last_receive(base[A]["last_receive"]), str(sA["last_receive"]))
    check("B available UP by 3", sB["available"] == base[B]["available"] + 3)
    check("B physical UP by 3", sB["physical"] == base[B]["physical"] + 3)
    sh1 = rest("GET", f"shipments?ship_id=eq.{SHIP1}&select=status,received_date")[0]
    check("shipment → completed", sh1["status"] == "completed" and sh1["received_date"] == R, str(sh1))
    po1 = rest("GET", f"purchase_orders?ship_id=eq.{SHIP1}&item_code=eq.{A}&select=status,receive_date")[0]
    check("D4: matching PO → Received + receive_date", po1["status"] == "Received" and po1["receive_date"] == R, str(po1))

    # ── CASE 2: partial receive (no close) — shipment stays open, shorts still visible ──
    print("\n-- CASE 2: partial receive --")
    rest("POST", "shipments", body=[{"ship_id": SHIP2, "origin_country": "Japan", "status": "open",
         "ship_date": "2026-06-02", "contents": [{"qty": 2, "item": C}, {"qty": 2, "item": D}]}], prefer="return=minimal")
    receipt(SHIP2, [{"item_code": C, "qty": 1, "excluded": False}], False)
    sC = stock(C)
    check("C available UP by 1 (partial)", sC["available"] == base[C]["available"] + 1, f'{base[C]["available"]}→{sC["available"]}')
    check("C physical UP by 1", sC["physical"] == base[C]["physical"] + 1)
    sh2 = rest("GET", f"shipments?ship_id=eq.{SHIP2}&select=status,received_date,contents")[0]
    check("shipment stays open (not closed)", sh2["status"] == "open" and sh2["received_date"] is None, str(sh2["status"]))
    items = {c["item"] for c in (sh2["contents"] or [])}
    check("expected list intact (C short, D missing still derivable)", items == {C, D}, str(items))
    inb2 = rest("GET", f"inbound?ship_id=eq.{SHIP2}&select=item_code")
    check("only C received (D not yet)", [r["item_code"] for r in inb2] == [C], str(inb2))

    # ── CASE 3: excluded line adds 0 to available/physical ──
    print("\n-- CASE 3: excluded line --")
    pre_d = stock(D)
    receipt(ADHOC, [{"item_code": D, "qty": 5, "excluded": True, "label": "Exclude"}], False)
    sD = stock(D)
    check("excluded row adds 0 to available", sD["available"] == pre_d["available"], f'{pre_d["available"]}→{sD["available"]}')
    check("excluded row adds 0 to physical", sD["physical"] == pre_d["physical"])
    exc = rest("GET", f"inbound?ship_id=eq.{ADHOC}&item_code=eq.{D}&select=excluded,label")[0]
    check("excluded inbound row persisted (excluded=true, label=Exclude)", exc["excluded"] is True and exc["label"] == "Exclude")

    # ── CASE 4: signed negative correction lowers available/physical ──
    print("\n-- CASE 4: negative correction --")
    pre_a = stock(A)
    receipt(ADHOC, [{"item_code": A, "qty": -1, "excluded": False}], False)
    sA2 = stock(A)
    check("A available DOWN by 1 (signed −1)", sA2["available"] == pre_a["available"] - 1, f'{pre_a["available"]}→{sA2["available"]}')
    check("A physical DOWN by 1", sA2["physical"] == pre_a["physical"] - 1)

    # ── CASE 5: barcode collision — resolveBarcode pattern returns BOTH SKUs (D1) ──
    print("\n-- CASE 5: barcode collision (D1) --")
    rest("POST", "barcodes", body=[{"barcode": BC_COLLIDE, "item_code": A, "is_verified": False},
                                    {"barcode": f"{BC_COLLIDE}#2", "item_code": B, "is_verified": False}],
         prefer="return=minimal")
    exact = rest("GET", f"barcodes?barcode=eq.{urllib.parse.quote(BC_COLLIDE)}&select=item_code")
    suffixed = rest("GET", f"barcodes?barcode=like.{urllib.parse.quote(BC_COLLIDE + '#')}*&select=item_code")
    resolved = {r["item_code"] for r in (exact + suffixed)}
    check("resolveBarcode pattern returns BOTH colliding SKUs", resolved == {A, B}, str(resolved))
    # receiving the chosen SKU writes inbound to that SKU only
    pre_b = stock(B)
    receipt(ADHOC, [{"item_code": B, "qty": 1, "excluded": False}], False)
    sB2 = stock(B)
    check("receiving the chosen SKU (B) writes to B only", sB2["available"] == pre_b["available"] + 1)
    chose = rest("GET", f"inbound?ship_id=eq.{ADHOC}&item_code=eq.{A}&select=inbound_id")
    # A only has the negative-correction row from CASE 4; the collision receive went to B, not A
    check("no stray inbound to the OTHER colliding SKU from this receive", len(chose) == 1, f"A adhoc rows={len(chose)} (the −1 correction)")

    # ── CASE 6: unknown barcode → needs_review stub, then receivable (D2) ──
    print("\n-- CASE 6: unknown-barcode needs_review stub (D2) --")
    rest("POST", "catalogue", body=[{"item_code": STUB_CODE, "translate_name": "Smoke Stub", "needs_review": True}],
         prefer="return=minimal")
    rest("POST", "barcodes", body=[{"barcode": BC_UNKNOWN, "item_code": STUB_CODE, "is_verified": False}], prefer="return=minimal")
    nr = rest("GET", f"catalogue?item_code=eq.{STUB_CODE}&select=needs_review")[0]
    check("stub flagged needs_review=true", nr["needs_review"] is True)
    affs = receipt(ADHOC, [{"item_code": STUB_CODE, "qty": 4, "excluded": False}], False)
    ss = stock(STUB_CODE)
    check("stub receivable: returns affected", isinstance(affs, list) and STUB_CODE in affs, str(affs))
    check("stub available UP by 4 (from 0)", ss["available"] == 4, str(ss["available"]))
    check("stub physical UP by 4", ss["physical"] == 4)

    # ── CASE 7: next_adhoc_ship_id allocator — 📦YYMMXXX, current period ──
    print("\n-- CASE 7: 📦YYMMXXX allocator --")
    nid = rest("POST", "rpc/next_adhoc_ship_id", body={})
    nid = nid if isinstance(nid, str) else (nid[0] if isinstance(nid, list) and nid else nid)
    m = re.match(r"^📦(\d{4})(\d{3})$", nid or "")
    check("returns a well-formed 📦YYMMXXX id", bool(m), repr(nid))
    check("id period = current YYMM (Asia/Jakarta)", bool(m) and m.group(1) == PERIOD, f"{nid} vs {PERIOD}")

    # ── CASE 8: fail loud on an unknown item_code (never silently NULLed) ──
    print("\n-- CASE 8: fail-loud on unknown item_code --")
    raised = False
    try:
        receipt(ADHOC, [{"item_code": "ZZ-RCV-NOPE", "qty": 1, "excluded": False}], False)
    except urllib.error.HTTPError as e:
        raised = "unknown/blank item_code" in e.read().decode(errors="replace")
    check("record_receipt rejects an unknown item_code (loud, no insert)", raised)
    stray = rest("GET", "inbound?item_code=eq.ZZ-RCV-NOPE&select=inbound_id")
    check("nothing inserted for the bad code", stray == [], str(stray))

finally:
    cleanup()

# zero-residual + baseline restore
print("\n-- residual / restore check --")
try:
    for c in (A, B, C, D):
        s = stock(c)
        ok = s["available"] == base[c]["available"] and s["physical"] == base[c]["physical"]
        check(f"{c} stock restored to baseline", ok, f"base={base[c]} now={s}")
    check("no residual test inbound", rest("GET", "inbound?ship_id=like.ZZ-RCV-*&select=inbound_id") == [])
    check("no residual test shipments", rest("GET", "shipments?ship_id=like.ZZ-RCV-*&select=ship_id") == [])
    check("no residual test POs", rest("GET", "purchase_orders?ship_id=like.ZZ-RCV-*&select=po_id") == [])
    check("no residual test catalogue stub", rest("GET", f"catalogue?item_code=eq.{STUB_CODE}&select=item_code") == [])
    check("no residual test barcodes", rest("GET", f"barcodes?barcode=like.{urllib.parse.quote('ZZRCVBC_')}*&select=barcode") == [])
except NameError:
    pass

print(f"\n{'ALL PASS' if not FAIL else 'FAILURES: ' + ', '.join(FAIL)}  ({len(PASS)} passed, {len(FAIL)} failed)")
sys.exit(1 if FAIL else 0)
