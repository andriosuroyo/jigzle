'use client';

import { useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@jigzle/db/client';
import { Suspense } from 'react';

function LoginInner() {
  const params = useSearchParams();
  const error = params.get('error');

  async function signInWithGoogle() {
    const supabase = createSupabaseBrowserClient();
    const origin = window.location.origin;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo-big">J</div>
        <h1>Jigzle Ops</h1>
        <p>Sign in with your Google account to continue.</p>
        {error === 'unauthorized' && (
          <div className="err">This Google account is not authorized.</div>
        )}
        <button onClick={signInWithGoogle}>
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86a5.27 5.27 0 0 1-4.96-3.65H.96v2.33A8.99 8.99 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M4.04 10.77a5.4 5.4 0 0 1 0-3.43V5H.96a9 9 0 0 0 0 8.1l3.08-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.94 8.94 0 0 0 9 0 8.99 8.99 0 0 0 .96 5l3.08 2.34A5.27 5.27 0 0 1 9 3.58z"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login-wrap"><div className="login-card">Loading…</div></div>}>
      <LoginInner />
    </Suspense>
  );
}
