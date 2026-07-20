# Incremental SKU-image ingest (weekly "quick pass for flagged SKUs")

Fills the picture gap for `pending` SKUs as new edited images land in the `#Jigzle` Drive library —
**without** the full local-folder run of `import_images.py`.

## Why a separate script

`import_images.py` walks the **whole** Drive library from local disk and **resets every unmatched SKU
to `pending`** — safe only with the complete folders in hand. `ingest_images_incremental.py` is
**additive-only**: it touches *only* the SKUs whose files are in its `--dir`, so it's safe to run on a
handful of files. Same encode/upload/DB contract (300px `display.webp` → `sku-images/{code}/display.webp`,
`sku_images` row + `catalogue.primary_image_id` + `image_status`), idempotent via `content_hash`.

## The gap, defined

- `catalogue.image_status = 'pending'` = no bucket image (the **Fix → Missing image** list).
- Most `pending` SKUs are genuinely image-less. The fillable gap = Drive `<code>_edit` files **created
  since the last ingest**, whose watermark is `max(sku_images.created_at)`.

## Weekly pass (run in a Claude session with the Google Drive connector authed)

1. **Watermark:** `GET catalogue`… actually `sku_images?select=created_at&order=created_at.desc&limit=1`.
2. **Find new edited files:** Drive search
   `mimeType contains 'image/' and createdTime > '<watermark>' and title contains '_edit'` (paginate).
3. **Keep the flagged ones:** parse `<code>` from each `<code>_edit.jpg`; keep those whose
   `catalogue.image_status = 'pending'` (a re-ingest of a `has_image` SKU is harmless but optional).
4. **Download → decode:** `download_file_content` each (the connector saves base64 to a tool-results
   file tagged with its `title`); decode every `*download_file_content*.txt` → `dl/<title>`.
5. **Ingest:** `python3 scripts/import/ingest_images_incremental.py --dir dl` (dry-run), then `--execute`.
6. **Report:** the pending count before/after and any errors.

Env needed: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (present in the ops environment);
`pip install Pillow`.

## Full backlog / re-baseline

When the whole library is available locally (Drive Desktop on a Mac), the canonical
`import_images.py --dir-a "<A. Pre Edited>" --dir-b "<B. Edited (_edit)>" --execute` is still the tool
to re-baseline everything at once. The incremental script is for the steady-state weekly delta.

## Scope note (v1)

The weekly pass grabs `_edit` (the curated primary) deltas. Raw-only additions (`_0…_n` with no
`_edit`) for still-pending SKUs are rarer and not yet swept here — extend the Drive search if needed.
