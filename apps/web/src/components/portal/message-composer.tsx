'use client';

import * as React from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { MESSAGE_COUNTER_AT, MESSAGE_MAX } from '@/lib/portal/messages';
import { EMAIL_RE, identityStore, intakeStore, type Identity } from './branding';

function initialIdentity(token: string): { identity: Identity; remembered: boolean } {
  const saved = identityStore.load(token);
  if (saved?.name?.trim()) return { identity: { name: saved.name, email: saved.email ?? '' }, remembered: true };
  const intake = intakeStore.load(token);
  return { identity: { name: intake?.name ?? '', email: intake?.email ?? '' }, remembered: false };
}

/**
 * Textarea + send. Enter sends, Shift+Enter inserts a newline. The client's name (and optional email, so the team's
 * replies can be emailed) is asked once, on the first message, and remembered on this device per portal.
 */
export function MessageComposer({
  token, sending, placeholder, autoFocus, onSend,
}: {
  token: string;
  sending: boolean;
  placeholder: string;
  autoFocus?: boolean;
  /** Resolve on success (the draft is cleared); throw to keep the draft. */
  onSend: (body: string, who: Identity) => Promise<void>;
}) {
  const init = React.useMemo(() => initialIdentity(token), [token]);
  const [identity, setIdentity] = React.useState(init.identity);
  const [remembered, setRemembered] = React.useState(init.remembered);
  const [editing, setEditing] = React.useState(!init.remembered);
  const [body, setBody] = React.useState('');
  const [errors, setErrors] = React.useState<{ name?: string; email?: string; send?: string }>({});
  const area = React.useRef<HTMLTextAreaElement>(null);
  const nameInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (autoFocus && window.matchMedia?.('(pointer: fine)').matches) area.current?.focus();
  }, [autoFocus]);

  // grow with content, up to ~6 lines
  React.useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [body]);

  async function submit() {
    const text = body.trim();
    if (!text || sending) return;
    const next: typeof errors = {};
    const name = identity.name.trim();
    const email = identity.email.trim();
    if (!name) next.name = 'Please add your name so the team knows who’s writing.';
    if (email && !EMAIL_RE.test(email)) next.email = 'That email address doesn’t look right.';
    setErrors(next);
    if (next.name || next.email) {
      setEditing(true);
      requestAnimationFrame(() => nameInput.current?.focus());
      return;
    }
    try {
      await onSend(text, { name, email });
      identityStore.save(token, { name, email });
      setRemembered(true);
      setEditing(false);
      setBody('');
      requestAnimationFrame(() => area.current?.focus());
    } catch (e) {
      setErrors({ send: e instanceof Error ? e.message : 'Your message couldn’t be sent. Please try again.' });
    }
  }

  const len = body.length;
  const nearLimit = len >= MESSAGE_COUNTER_AT;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-2.5 border-t border-border bg-surface p-3 sm:p-4"
    >
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-2.5">
          <Field label="Your name" required error={errors.name}>
            <Input
              ref={nameInput} value={identity.name} autoComplete="name" maxLength={120}
              onChange={(e) => {
                setIdentity((v) => ({ ...v, name: e.target.value }));
                if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
              }}
              className="text-base sm:text-sm"
            />
          </Field>
          <Field label="Email (optional)" error={errors.email}>
            <Input
              type="email" inputMode="email" value={identity.email} autoComplete="email" maxLength={254}
              onChange={(e) => {
                setIdentity((v) => ({ ...v, email: e.target.value }));
                if (errors.email) setErrors((x) => ({ ...x, email: undefined }));
              }}
              className="text-base sm:text-sm"
            />
          </Field>
          </div>
          <p className="text-xs text-fg-subtle">Add your email to get the team’s replies by email too.</p>
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
          Sending as <span className="font-medium text-fg">{identity.name}</span>
          {identity.email && <span className="text-fg-subtle">({identity.email})</span>}
          <span aria-hidden>·</span>
          <button type="button" onClick={() => setEditing(true)} className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Change
          </button>
        </p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={area} value={body} rows={1} maxLength={MESSAGE_MAX} placeholder={placeholder} aria-label="Write a message" disabled={sending}
          onChange={(e) => {
            setBody(e.target.value);
            if (errors.send) setErrors((x) => ({ ...x, send: undefined }));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="max-h-40 min-h-11 w-full flex-1 resize-none rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-base leading-6 text-fg shadow-xs transition-colors duration-150 placeholder:text-fg-subtle hover:border-fg-subtle/60 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-60 sm:text-sm sm:leading-[22px]"
        />
        <Button type="submit" size="lg" loading={sending} disabled={!body.trim()} aria-label="Send message" className="h-11 shrink-0 px-4">
          {!sending && <SendHorizontal aria-hidden />}
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>

      <div className={cn('items-center justify-between gap-3 text-xs text-fg-subtle', nearLimit ? 'flex' : 'hidden sm:flex')}>
        <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
        {nearLimit && (
          <span className={cn('ml-auto tabular-nums', len >= MESSAGE_MAX ? 'font-medium text-danger' : 'text-fg-muted')} role="status">
            {len.toLocaleString('en-US')} / {MESSAGE_MAX.toLocaleString('en-US')}
          </span>
        )}
      </div>
      {errors.send && <p role="alert" className="text-sm text-danger">{errors.send}</p>}
    </form>
  );
}
