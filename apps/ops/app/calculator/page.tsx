import { createSupabaseServerClient } from '@jigzle/db/server';
import CalculatorBoard from '@/components/CalculatorBoard';
import type { Currency, ShippingMethod, UserPrefs } from '@jigzle/db/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Server shell: load shipping methods + currencies + the user's prefs, render the board. (History and
// Rates moved out — see Settings › Calculator.)
export default async function CalculatorPage() {
  const supabase = createSupabaseServerClient();

  const [methodsRes, currenciesRes, prefsRes, userRes] = await Promise.all([
    supabase.from('shipping_methods').select('*').eq('active', true).order('sort_order'),
    supabase.from('currencies').select('*'),
    supabase.from('user_prefs').select('*').maybeSingle(),
    supabase.auth.getUser(),
  ]);

  return (
    <CalculatorBoard
      initialMethods={(methodsRes.data || []) as ShippingMethod[]}
      initialCurrencies={(currenciesRes.data || []) as Currency[]}
      initialPrefs={(prefsRes.data || null) as UserPrefs | null}
      userEmail={userRes.data.user?.email || ''}
    />
  );
}
