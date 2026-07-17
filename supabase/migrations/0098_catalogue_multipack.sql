-- 0098 — PR370: Multipack / Blind Box sets on a catalogue SKU.
-- A single SKU box can hold several sub-puzzles, each with its own piece count + product dimensions
-- (e.g. a multipack of 300pc 38×26 + 500pc 52×38). Two additive columns:
--   set_count  int    — number of units in the box (1 = single; ≥2 = multipack / blind box)
--   components jsonb   — per-unit rows [{pieces, p, l, t}, …] for the varying sizes
-- piece_type now carries only the CATEGORY (Pieces / Multipack / Blind Box); the count moved to
-- set_count. This migration also normalizes legacy piece_type values like "Multipack 2" / "Blind Box 3"
-- by splitting the trailing number into set_count. Additive & idempotent.
-- Verify after applying:
--   select piece_type, set_count, count(*) from catalogue group by 1,2 order by 3 desc limit 20;

alter table public.catalogue add column if not exists set_count int;
alter table public.catalogue add column if not exists components jsonb;

-- legacy "Multipack 2" / "Blind Box 3" / "Blindbox 1" → set_count = the trailing number, piece_type = base.
update public.catalogue
set set_count = nullif((regexp_match(piece_type, '(\d+)\s*$'))[1], '')::int,
    piece_type = btrim(regexp_replace(piece_type, '\s*\d+\s*$', ''))
where piece_type is not null and piece_type ~* '(multipack|blind\s*box)';

-- normalize the base spelling to the two canonical labels.
update public.catalogue set piece_type = 'Multipack' where piece_type ~* '^\s*multipack\s*$';
update public.catalogue set piece_type = 'Blind Box' where piece_type ~* '^\s*blind\s*?box\s*$';
