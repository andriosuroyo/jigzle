'use server';

// Server actions for the pricing Calculator (PR93 — ported from the standalone jigzle-calculator app).
// Same auth posture as the rest of ops: the SSR supabase client (anon key + the signed-in user's
// session), so RLS gates every read/write. Writes carry the server-resolved user_id (never trusted
// from the client).

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { Currency, SavedCalculation, UserPrefs } from '@jigzle/db/types';

type SaveCalcInput = Omit<SavedCalculation, 'id' | 'user_id' | 'created_at'>;
type PrefsInput = Omit<UserPrefs, 'user_id' | 'updated_at'>;

// ── save a calculation (stamped with the signed-in user) ──
export async function saveCalculation(input: SaveCalcInput): Promise<SavedCalculation> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('saveCalculation: not signed in');
  const { data, error } = await supabase.from('calculations').insert({ ...input, user_id: user.id }).select('*').single();
  if (error) throw new Error(`saveCalculation: ${error.message}`);
  return data as SavedCalculation;
}

// ── delete a saved calculation ──
export async function deleteCalculation(id: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('calculations').delete().eq('id', id);
  if (error) throw new Error(`deleteCalculation: ${error.message}`);
}

// ── persist the user's form defaults (debounced from the client) ──
export async function savePrefs(input: PrefsInput): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('user_prefs').upsert({ ...input, user_id: user.id }, { onConflict: 'user_id' });
}

// ── refresh live FX (Frankfurter, IDR base) → updates the currencies table, returns the fresh rows ──
export async function refreshFx(): Promise<Currency[]> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: allowed } = await supabase.rpc('is_allowed_user');
  if (!user || !allowed) throw new Error('Not authorized.');

  const { data: rows, error: readErr } = await supabase.from('currencies').select('*');
  if (readErr) throw new Error(readErr.message);
  const currencies = (rows ?? []) as Currency[];
  const nonBase = currencies.filter((c) => c.code !== 'IDR');
  const fromList = nonBase.map((c) => c.code).join(',');

  const resp = await fetch(`https://api.frankfurter.app/latest?from=IDR&to=${fromList}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Frankfurter HTTP ${resp.status}`);
  const fxData = (await resp.json()) as { rates?: Record<string, number> };

  const now = new Date().toISOString();
  for (const cur of nonBase) {
    const r = fxData.rates?.[cur.code];
    if (r && r > 0) {
      const { error } = await supabase.from('currencies').update({ rate_to_idr: +(1 / r).toFixed(4), updated_at: now }).eq('code', cur.code);
      if (error) throw new Error(error.message);
    }
  }
  await supabase.from('currencies').update({ updated_at: now }).eq('code', 'IDR'); // bump base for the freshness label

  const { data: fresh, error: refErr } = await supabase.from('currencies').select('*');
  if (refErr) throw new Error(refErr.message);
  return (fresh ?? []) as Currency[];
}
