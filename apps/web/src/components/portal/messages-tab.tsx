'use client';

import { Card } from '@/components/ui';
import { MessageThread } from './message-thread';
import { usePortal } from './portal-context';

export function MessagesTab() {
  const { branding } = usePortal();
  const team = branding.companyName || 'the team';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-3xl">Messages</h1>
        <p className="text-sm text-fg-muted">Talk to {team} directly. Replies show up here.</p>
      </div>
      <Card className="flex h-[calc(100dvh-17.5rem-env(safe-area-inset-bottom))] min-h-[24rem] flex-col overflow-hidden shadow-sm md:h-[calc(100dvh-17rem)]">
        <MessageThread
          fileId={null} placeholder="Write a message…" emptyTitle="No messages yet"
          emptyHint="Ask a question or share an update with {team}. They’ll see it right away."
        />
      </Card>
    </div>
  );
}
