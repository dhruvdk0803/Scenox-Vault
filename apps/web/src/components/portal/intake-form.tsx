'use client';

import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import { EMAIL_RE, EMPTY_INTAKE, type IntakeValues } from './branding';

export interface IntakeRequirements {
  requireName: boolean;
  requireEmail: boolean;
  requireCompany: boolean;
  requireMessage: boolean;
}

export const needsIntake = (r: IntakeRequirements) => r.requireName || r.requireEmail || r.requireCompany || r.requireMessage;

export function IntakeForm({ requirements, initial, onSubmit }: { requirements: IntakeRequirements; initial?: IntakeValues | null; onSubmit: (v: IntakeValues) => void }) {
  const [values, setValues] = React.useState<IntakeValues>({ ...EMPTY_INTAKE, ...initial });
  const [errors, setErrors] = React.useState<Partial<Record<keyof IntakeValues, string>>>({});

  const set = (k: keyof IntakeValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: undefined }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (requirements.requireName && !values.name.trim()) next.name = 'Please enter your name.';
    if (requirements.requireCompany && !values.company.trim()) next.company = 'Please enter your company.';
    if (requirements.requireEmail) {
      if (!values.email.trim()) next.email = 'Please enter your email address.';
      else if (!EMAIL_RE.test(values.email.trim())) next.email = 'That email address doesn’t look right.';
    }
    if (requirements.requireMessage && !values.message.trim()) next.message = 'Please add a short message.';
    setErrors(next);
    if (Object.keys(next).length === 0) onSubmit({ name: values.name.trim(), email: values.email.trim(), company: values.company.trim(), message: values.message.trim() });
  }

  return (
    <Card className="animate-fade-in p-5 shadow-sm sm:p-8">
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight text-fg">Before you upload</h2>
          <p className="text-sm text-fg-muted">A few details so we know who the files are from.</p>
        </div>
        {requirements.requireName && (
          <Field label="Your name" required error={errors.name}>
            <Input value={values.name} onChange={set('name')} autoComplete="name" className="h-11 text-base sm:text-sm" />
          </Field>
        )}
        {requirements.requireEmail && (
          <Field label="Email address" required error={errors.email}>
            <Input type="email" inputMode="email" value={values.email} onChange={set('email')} autoComplete="email" className="h-11 text-base sm:text-sm" />
          </Field>
        )}
        {requirements.requireCompany && (
          <Field label="Company" required error={errors.company}>
            <Input value={values.company} onChange={set('company')} autoComplete="organization" className="h-11 text-base sm:text-sm" />
          </Field>
        )}
        {requirements.requireMessage && (
          <Field label="Message" required error={errors.message}>
            <Textarea value={values.message} onChange={set('message')} rows={4} className="text-base sm:text-sm" />
          </Field>
        )}
        <Button type="submit" size="lg" className="sm:self-end">
          Continue
          <ArrowRight aria-hidden />
        </Button>
      </form>
    </Card>
  );
}
