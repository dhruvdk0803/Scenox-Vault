'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Circle } from 'lucide-react';
import type { MeDTO, SetupRequest, SetupStatusDTO } from '@scenox/shared';
import { api, ApiClientError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthError } from '../auth-error';

const MIN_LENGTH = 12;

function evaluate(pw: string) {
  const checks = [
    { id: 'len', label: `At least ${MIN_LENGTH} characters`, ok: pw.length >= MIN_LENGTH, required: true },
    { id: 'case', label: 'Upper and lower case letters', ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), required: false },
    { id: 'num', label: 'A number', ok: /\d/.test(pw), required: false },
    { id: 'sym', label: 'A symbol', ok: /[^A-Za-z0-9]/.test(pw), required: false },
  ];
  const extra = checks.filter((c) => !c.required && c.ok).length + (pw.length >= 16 ? 1 : 0);
  const level = !checks[0]!.ok ? (pw.length ? 0 : -1) : extra >= 3 ? 3 : extra >= 2 ? 2 : 1;
  return { checks, level };
}

const LEVELS = [
  { label: 'Too short', bar: 'bg-danger-solid', text: 'text-danger' },
  { label: 'Fair', bar: 'bg-warning', text: 'text-warning' },
  { label: 'Good', bar: 'bg-info', text: 'text-info' },
  { label: 'Strong', bar: 'bg-success', text: 'text-success' },
];

export function SetupForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<SetupStatusDTO>('/auth/setup-status', { signal: ctrl.signal, redirectOn401: false })
      .then((s) => !s.needsSetup && router.replace('/login'))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [router]);

  const { checks, level } = evaluate(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = name.trim() && email.trim() && level >= 0 && checks[0]!.ok && password === confirm;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || loading) return;
    setError(null);
    setLoading(true);
    try {
      const body: SetupRequest = { name: name.trim(), email: email.trim(), password };
      const me = await api.post<MeDTO>('/auth/setup', body, { redirectOn401: false });
      queryClient.setQueryData(queryKeys.me, me);
      router.replace('/dashboard');
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiClientError && err.status === 409) {
        router.replace('/login');
        return;
      }
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong. Please try again.');
    }
  }

  const meta = level >= 0 ? LEVELS[level]! : null;

  return (
    <Card className="shadow-sm">
      <CardContent className="p-6">
        <h1 className="text-xl font-semibold tracking-tight">Set up Scenox Vault</h1>
        <p className="mb-6 mt-1 text-sm text-fg-muted">Create the owner account. You can invite teammates later.</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <AuthError message={error} />
          <Field label="Full name" required>
            <Input name="name" autoComplete="name" autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" required>
            <Input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <div className="flex flex-col gap-2">
            <Field label="Password" required>
              <Input type="password" name="new-password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="pw-reqs" />
            </Field>
            <div id="pw-reqs" className="flex flex-col gap-2">
              <div className="flex items-center gap-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span key={i} className={cn('h-1 flex-1 rounded-full bg-surface-muted transition-colors duration-150', meta && i < Math.max(1, level) && meta.bar)} />
                ))}
              </div>
              <p className={cn('text-xs font-medium', meta?.text ?? 'text-fg-subtle')} aria-live="polite">
                {meta ? `Password strength: ${meta.label}` : 'Password strength'}
              </p>
              <ul className="grid gap-1">
                {checks.map((c) => (
                  <li key={c.id} className={cn('flex items-center gap-1.5 text-xs', c.ok ? 'text-success' : 'text-fg-subtle')}>
                    {c.ok ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
                    {c.label}
                    {!c.required && <span className="text-fg-subtle">(recommended)</span>}
                    <span className="sr-only">{c.ok ? ' — met' : ' — not met'}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <Field label="Confirm password" required error={mismatch ? 'Passwords do not match.' : undefined}>
            <Input type="password" name="confirm-password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" loading={loading} disabled={!valid} className="mt-1">
            {loading ? 'Creating account…' : 'Create owner account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
