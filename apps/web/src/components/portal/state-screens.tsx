'use client';

import * as React from 'react';
import { CircleOff, LinkIcon, ServerCrash, TimerOff } from 'lucide-react';
import { Button, Card, Skeleton } from '@/components/ui';

function Contact({ email }: { email?: string | null }) {
  return email ? (
    <>
      {' '}
      Please contact{' '}
      <a href={`mailto:${email}`} className="font-medium text-primary underline-offset-4 hover:underline">
        {email}
      </a>
      .
    </>
  ) : (
    <> Please contact the person who sent you this link.</>
  );
}

function StateCard({ icon, title, children, action }: { icon: React.ReactNode; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="mx-auto mt-6 flex max-w-md animate-fade-in flex-col items-center gap-4 px-6 py-12 text-center shadow-sm sm:px-10">
      <div className="flex size-14 items-center justify-center rounded-full bg-surface-muted text-fg-subtle [&_svg]:size-6" aria-hidden>
        {icon}
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        <p className="text-sm text-fg-muted">{children}</p>
      </div>
      {action}
    </Card>
  );
}

export function NotFoundState({ supportEmail }: { supportEmail?: string | null }) {
  return (
    <StateCard icon={<LinkIcon />} title="This link isn’t valid">
      Check the link you received.
      <Contact email={supportEmail} />
    </StateCard>
  );
}

export function ExpiredState({ supportEmail }: { supportEmail?: string | null }) {
  return (
    <StateCard icon={<TimerOff />} title="This upload link has expired">
      Links stop working after a set time to keep your files safe.
      <Contact email={supportEmail} />
    </StateCard>
  );
}

export function DisabledState({ supportEmail }: { supportEmail?: string | null }) {
  return (
    <StateCard icon={<CircleOff />} title="This upload link is no longer active">
      <Contact email={supportEmail} />
    </StateCard>
  );
}

export function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <StateCard icon={<ServerCrash />} title="We couldn’t load this page" action={<Button onClick={onRetry}>Try again</Button>}>
      {message}
    </StateCard>
  );
}

export function PortalSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}
