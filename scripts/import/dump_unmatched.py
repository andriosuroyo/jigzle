#!/usr/bin/env python3
"""Dump unmatched item_code rows (current Sales Data + Inbound Data) to a CSV for review.

For each unmatched code it adds `possible_catalogue_match`: a catalogue code that matches
after upper-casing + stripping spaces/tabs/dashes — i.e. a likely FORMAT-DRIFT case worth
fixing, vs a blank (genuinely-unknown SKU). Reads only; writes the CSV; touches no DB.
Output: migration/unmatched-itemcodes.csv
"""
import sys
import csv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import transforms as t          # noqa: E402
import import_jigzle as imp      # noqa: E402


def norm(s):
    return (s or "").strip().upper().replace(" ", "").replace("\t", "").replace("-", "")


# valid catalogue codes + a normalized→canonical map for the drift hint
valid, normmap = set(), {}
for path, _ in imp.CATALOGUE_FILES:
    _, data = imp.read_tab(path, "Catalog", 1)
    for row in data:
        c = t.clean(imp.g(row, 0))
        if c:
            valid.add(c)
            normmap.setdefault(norm(c), c)


def hint(raw):
    m = normmap.get(norm(raw))
    return m if m and m != raw else ""


rows = []
# ── current Sales Data line rows (not 📦 headers) ──
_, sd = imp.read_tab(imp.SALES, "Sales Data", 1)
for r in sd:
    sid, ic = t.clean(imp.g(r, 0)), imp.g(r, 4)
    if not sid or ic in (None, "") or str(ic).startswith("📦"):
        continue
    raw = t.clean(ic)
    if not raw or raw in valid:
        continue
    rows.append(["Sales Data (active)", raw, hint(raw), sid, t.clean(imp.g(r, 1)),
                 t.clean(imp.g(r, 2)), t.to_int(imp.g(r, 5)), t.clean(imp.g(r, 3)),
                 t.clean(imp.g(r, 6)), t.clean(imp.g(r, 7))])

# ── Inbound Data ──
_, ib = imp.read_tab(imp.INBOUND, "Inbound Data", 2)
for r in ib:
    if not imp.nonempty(r):
        continue
    qty = t.to_int(imp.g(r, 1))
    raw = t.clean(imp.g(r, 0))
    if qty is None or not raw or raw in valid:
        continue
    rows.append(["Inbound Data", raw, hint(raw), t.clean(imp.g(r, 2)), "",
                 t.clean(imp.g(r, 3)), qty, "", t.clean(imp.g(r, 4)), t.clean(imp.g(r, 6))])

out = imp.REPO_ROOT / "migration/unmatched-itemcodes.csv"
with out.open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["source", "raw_item_code", "possible_catalogue_match",
                "ref (sales_id / ship_id)", "line_id (encrypt)", "date",
                "qty", "customer_ref", "item_link", "note / resi-detail"])
    w.writerows(rows)

# summary
sales = [r for r in rows if r[0].startswith("Sales")]
inb = [r for r in rows if r[0] == "Inbound Data"]
sales_drift = sum(1 for r in sales if r[2])
inb_drift = sum(1 for r in inb if r[2])
print(f"wrote {out}  ({len(rows)} rows)")
print(f"  Sales Data (active): {len(sales)}  — {sales_drift} look like format-drift (possible match found)")
print(f"  Inbound Data       : {len(inb)}  — {inb_drift} look like format-drift")
print("\nformat-drift examples (raw → possible match):")
for r in [x for x in rows if x[2]][:12]:
    print(f"   {r[0]:<20} {r[1]:<22} → {r[2]}")
