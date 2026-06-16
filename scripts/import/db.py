"""Minimal PostgREST client for the Jigzle importer (stdlib only).

Connects with the SERVICE-ROLE key so writes bypass RLS (bulk load). Never use the
anon key here. In --dry-run the importer never constructs a Client, so nothing is
read from or written to the database.
"""
from __future__ import annotations
import json
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_env(path: Path | None = None) -> dict:
    """Parse .env.local (KEY=VALUE per line) without external deps."""
    path = path or (REPO_ROOT / ".env.local")
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class Client:
    def __init__(self, url: str, service_key: str, timeout: int = 180):
        if not url or not service_key:
            raise ValueError("Supabase URL and SERVICE-ROLE key are required.")
        self.base = url.rstrip("/") + "/rest/v1"
        self.timeout = timeout
        self.h = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def _req(self, method: str, path: str, *, body=None, prefer=None, retries=3):
        url = f"{self.base}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        headers = dict(self.h)
        if prefer:
            headers["Prefer"] = prefer
        last = None
        for attempt in range(retries):
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")
                last = RuntimeError(f"{method} {path} → HTTP {e.code}: {detail[:500]}")
                if e.code in (502, 503, 504, 408, 429):
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise last
            except (urllib.error.URLError, TimeoutError) as e:
                last = RuntimeError(f"{method} {path} → {e}")
                time.sleep(1.5 * (attempt + 1))
        raise last

    def ping(self):
        """Cheap connectivity/auth check."""
        self._req("GET", "brands?limit=1")

    def rpc(self, fn: str, params: dict | None = None):
        """Call a Postgres function via PostgREST (POST /rpc/<fn>)."""
        return self._req("POST", f"rpc/{fn}", body=params or {}, prefer="return=minimal")

    def column_exists(self, table: str, column: str) -> bool:
        try:
            self._req("GET", f"{table}?select={column}&limit=1")
            return True
        except RuntimeError as e:
            if "42703" in str(e) or "does not exist" in str(e).lower():
                return False
            raise

    def delete_all(self, table: str, chunk: int = 2000):
        """Clean-load delete, BATCHED. A single DELETE of a large parent table (e.g.
        catalogue, with 9 FK children) blows the role's statement_timeout because
        Postgres runs a referential-integrity check per deleted row. Limited DELETE
        (order + limit) caps each statement; we loop until nothing is left. select=
        created_at keeps the response tiny. Every data table has created_at."""
        path = (f"{table}?created_at=gte.1900-01-01&order=created_at"
                f"&limit={chunk}&select=created_at")
        while True:
            res = self._req("DELETE", path, prefer="return=representation")
            if not res:
                break

    def count(self, table: str):
        """Exact row count via the Content-Range header (post-load verification)."""
        url = f"{self.base}/{table}?select=*"
        headers = dict(self.h)
        headers["Prefer"] = "count=exact"
        headers["Range-Unit"] = "items"
        headers["Range"] = "0-0"
        req = urllib.request.Request(url, method="GET", headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            cr = resp.headers.get("Content-Range", "")
        tail = cr.split("/")[-1] if "/" in cr else ""
        return int(tail) if tail.isdigit() else None

    def insert(self, table: str, rows: list[dict], *, returning: bool = False, batch: int = 500):
        """Bulk insert in batches. With returning=True, returns inserted rows in input order."""
        prefer = "return=representation" if returning else "return=minimal"
        # PostgREST (PGRST102) requires every object in a bulk insert to share the same
        # keys. Group rows by their key-signature and send each group separately — this
        # keeps requests uniform WITHOUT null-filling, so omitted columns keep their DB
        # defaults (e.g. created_at / negara) instead of being forced to null.
        from collections import OrderedDict
        groups = OrderedDict()
        for idx, r in enumerate(rows):
            groups.setdefault(frozenset(r.keys()), []).append((idx, r))
        results = {}
        for _sig, items in groups.items():
            for i in range(0, len(items), batch):
                chunk_items = items[i:i + batch]
                res = self._req("POST", table, body=[r for _ix, r in chunk_items], prefer=prefer)
                if returning and res:
                    for (orig_idx, _r), rr in zip(chunk_items, res):
                        results[orig_idx] = rr
        return [results[i] for i in range(len(rows))] if returning else None
