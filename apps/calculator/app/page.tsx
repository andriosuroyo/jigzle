import { createSupabaseServerClient } from '@jigzle/db/server';
import App from '@/components/App';
import type { Currency, ShippingMethod, SavedCalculation, UserPrefs } from '@jigzle/db/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Home() {
  const supabase = createSupabaseServerClient();

  const [methodsRes, currenciesRes, calcsRes, prefsRes, userRes] = await Promise.all([
    supabase.from('shipping_methods').select('*').eq('active', true).order('sort_order'),
    supabase.from('currencies').select('*'),
    supabase.from('calculations').select('*').order('created_at', { ascending: false }),
    supabase.from('user_prefs').select('*').maybeSingle(),
    supabase.auth.getUser(),
  ]);

  const methods = (methodsRes.data || []) as ShippingMethod[];
  const currencies = (currenciesRes.data || []) as Currency[];
  const calculations = (calcsRes.data || []) as SavedCalculation[];
  const prefs = (prefsRes.data || null) as UserPrefs | null;
  const userEmail = userRes.data.user?.email || '';

  return (
    <App
      initialMethods={methods}
      initialCurrencies={currencies}
      initialCalculations={calculations}
      initialPrefs={prefs}
      userEmail={userEmail}
    />
  );
}
