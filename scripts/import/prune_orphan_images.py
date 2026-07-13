#!/usr/bin/env python3
"""Storage saver — delete orphan objects from the `sku-images` bucket (bucket → nothing else touched).

The importer never deletes (import_images.py prints "DELETES: 0"), so every display.webp ever uploaded
for an item_code that is no longer a *live primary* — SKUs removed/renamed, or re-pointed so a stale
path lingers — keeps occupying the bucket. This sweep removes exactly those objects. It NEVER touches a
key that a live primary points to, and NEVER writes to any table.

Safety model (why it can't nuke a live image):
  * The keep-set is built from `sku_images.display_path` for is_primary rows — the EXACT object keys the
    app serves (display_path is already percent-encoded, e.g. CJK codes). We compare full object keys to
    that set, so encoding can never cause a false orphan (CLAUDE.md: CJK item codes exist).
  * Belt-and-suspenders: a key is also kept if its URL-decoded item_code is a live primary.
  * Dry-run by default; --apply required to delete. --apply deletes in batches with a printed running tally.

  python3 scripts/import/prune_orphan_images.py            # dry-run: list + size orphans, delete nothing
  python3 scripts/import/prune_orphan_images.py --apply    # actually delete the orphan objects
"""
import argparse, json, os, time, urllib.parse, urllib.request

BUCKET = "sku-images"
URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def _req(method, base, path, body=None, tries=6):
    for i in range(tries):
        try:
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(f"{URL}/{base}/{path}", data=data, headers=H, method=method)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(0.5 * (2 ** i))


def rest(path):
    return _req("GET", "rest/v1", path)


def storage_post(path, body):
    return _req("POST", "storage/v1", path, body)


def keep_set():
    """Exact object keys the app serves = display_path of every live primary (already encoded)."""
    keep, codes, off = set(), set(), 0
    while True:
        page = rest("sku_images?select=item_code,display_path&is_primary=is.true&display_path=not.is.null&limit=1000&offset=%d" % off)
        if not page:
            break
        for r in page:
            keep.add(r["display_path"])
            codes.add(r["item_code"])
        if len(page) < 1000:
            break
        off += 1000
    return keep, codes


def list_all_objects():
    """Every object key in the bucket + its byte size. Walks each item_code folder (one file each)."""
    folders, off = [], 0
    while True:
        page = storage_post(f"object/list/{BUCKET}",
                            {"prefix": "", "limit": 100, "offset": off, "sortBy": {"column": "name", "order": "asc"}})
        if not page:
            break
        folders += [e["name"] for e in page]
        if len(page) < 100:
            break
        off += 100
    objs = []
    for i, f in enumerate(folders):
        for o in storage_post(f"object/list/{BUCKET}", {"prefix": f + "/", "limit": 100, "offset": 0}):
            objs.append((f + "/" + o["name"], (o.get("metadata") or {}).get("size", 0)))
        if (i + 1) % 2000 == 0:
            print(f"  …listed {i + 1}/{len(folders)} folders")
    return objs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry-run)")
    a = ap.parse_args()

    print("building keep-set (live primaries) …")
    keep, live_codes = keep_set()
    print(f"  live primaries: {len(keep)}")

    print("listing bucket objects …")
    objs = list_all_objects()
    print(f"  bucket objects: {len(objs)}")

    orphans = []
    for key, size in objs:
        if key in keep:
            continue
        # belt-and-suspenders: keep if the key's folder decodes to a live item_code
        folder = key.split("/", 1)[0]
        if urllib.parse.unquote(folder) in live_codes:
            continue
        orphans.append((key, size))

    ob = sum(s for _, s in orphans)
    print(f"\norphan objects: {len(orphans)}  ·  {ob / 1024 / 1024:.1f} MB reclaimable")
    for key, size in orphans[:15]:
        print(f"   {size/1024:6.0f}KB  {key}")
    if len(orphans) > 15:
        print(f"   … +{len(orphans) - 15} more")

    if not a.apply:
        print("\ndry-run — nothing deleted. Re-run with --apply to delete these objects.")
        return
    if not orphans:
        print("nothing to delete.")
        return

    print(f"\ndeleting {len(orphans)} objects …")
    done = 0
    keys = [k for k, _ in orphans]
    for i in range(0, len(keys), 100):
        chunk = keys[i:i + 100]
        _req("DELETE", "storage/v1", f"object/{BUCKET}", body={"prefixes": chunk})
        done += len(chunk)
        print(f"  deleted {done}/{len(keys)}")
    print(f"done — removed {len(orphans)} orphan objects, freed ~{ob / 1024 / 1024:.1f} MB.")


if __name__ == "__main__":
    main()
