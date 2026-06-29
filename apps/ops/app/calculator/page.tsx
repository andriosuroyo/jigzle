import { createSupabaseServerClient } from '@jigzle/db/server';
import CalculatorBoard from '@/components/CalculatorBoard';
import type { Currency, ShippingMethod, SavedCalculation, UserPrefs } from '@jigzle/db/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load shipping methods + currencies + saved calculations + the user's prefs, render the board.
export default async function CalculatorPage() {
  const supabase = createSupabaseServerClient();

  const [methodsRes, currenciesRes, calcsRes, prefsRes, userRes] = await Promise.all([
    supabase.from('shipping_methods').select('*').eq('active', true).order('sort_order'),
    supabase.from('currencies').select('*'),
    supabase.from('calculations').select('*').order('created_at', { ascending: false }),
    supabase.from('user_prefs').select('*').maybeSingle(),
    supabase.auth.getUser(),
  ]);

  return (
    <CalculatorBoard
      initialMethods={(methodsRes.data || []) as ShippingMethod[]}
      initialCurrencies={(currenciesRes.data || []) as Currency[]}
      initialCalculations={(calcsRes.data || []) as SavedCalculation[]}
      initialPrefs={(prefsRes.data || null) as UserPrefs | null}
      userEmail={userRes.data.user?.email || ''}
    />
  );
}
