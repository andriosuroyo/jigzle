import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@jigzle/db/server';
import type { Currency } from '@jigzle/db/types';

export const dynamic = 'force-dynamic';

const ALLOWED_EMAIL = (process.env.ALLOWED_USER_EMAIL || 'andriosuroyo@gmail.com').toLowerCase();

export async function POST() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || (user.email || '').toLowerCase() !== ALLOWED_EMAIL) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data: rows, error: readErr } = await supabase
    .from('currencies')
    .select('*');
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  const currencies = (rows || []) as Currency[];
  const nonBase = currencies.filter((c) => c.code !== 'IDR');
  const fromList = nonBase.map((c) => c.code).join(',');

  let fxData: { rates?: Record<string, number> } = {};
  try {
    const resp = await fetch(`https://api.frankfurter.app/latest?from=IDR&to=${fromList}`, {
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error('Frankfurter HTTP ' + resp.status);
    fxData = await resp.json();
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'fx fetch failed' }, { status: 502 });
  }

  const updates: { code: string; rate_to_idr: number }[] = [];
  nonBase.forEach((c) => {
    const r = fxData.rates?.[c.code];
    if (r && r > 0) {
      updates.push({ code: c.code, rate_to_idr: +(1 / r).toFixed(4) });
    }
  });

  const now = new Date().toISOString();
  for (const u of updates) {
    const { error } = await supabase
      .from('currencies')
      .update({ rate_to_idr: u.rate_to_idr, updated_at: now })
      .eq('code', u.code);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Bump IDR updated_at too so the freshness indicator works.
  await supabase.from('currencies').update({ updated_at: now }).eq('code', 'IDR');

  const { data: fresh, error: refErr } = await supabase.from('currencies').select('*');
  if (refErr) return NextResponse.json({ error: refErr.message }, { status: 500 });

  return NextResponse.json({ currencies: fresh });
}
