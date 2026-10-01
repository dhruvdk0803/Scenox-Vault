'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, MeDTO, SetupStatusDTO } from '@scenox/shared';
import { api, ApiClientError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthError } from '../auth-error';

/** Only allow same-origin relative redirects. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard';
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<SetupStatusDTO>('/auth/setup-status', { signal: ctrl.signal, redirectOn401: false })
      .then((s) => s.needsSetup && router.replace('/setup'))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const body: LoginRequest = { email: email.trim(), password };
      const me = await api.post<MeDTO>('/auth/login', body, { redirectOn401: false });
      queryClient.setQueryData(queryKeys.me, me);
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiClientError) {
        if (err.status === 429) setError('Too many attempts. Please wait a few minutes and try again.');
        else if (err.status === 401 || err.status === 400) setError('Invalid email or password.');
        else setError(err.message);
      } else setError('Something went wrong. Please try again.');
    }
  }

  return (
    <Card className="shadow-sm">
      <CardContent className="p-6">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mb-6 mt-1 text-sm text-fg-muted">Welcome back. Enter your credentials to continue.</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <AuthError message={error} />
          <Field label="Email" required>
            <Input type="email" name="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password" required>
            <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" loading={loading} disabled={!email || !password} className="mt-1">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
