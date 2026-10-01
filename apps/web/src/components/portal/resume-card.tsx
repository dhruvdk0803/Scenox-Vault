'use client';

import { History } from 'lucide-react';
import { formatBytes, formatNumber } from '@scenox/shared';
import { Button, Card } from '@/components/ui';

export function ResumeCard({ count, bytes, onResume, onDiscard }: { count: number; bytes: number; onResume: () => void; onDiscard: () => void }) {
  return (
    <Card className="flex animate-fade-in flex-col gap-4 border-primary-soft-border bg-primary-soft p-5 sm:flex-row sm:items-center">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface text-primary" aria-hidden>
        <History className="size-5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-base font-semibold text-fg">Resume previous upload?</h2>
        <p className="text-sm text-fg-muted">
          {formatNumber(count)} {count === 1 ? 'file' : 'files'} ({formatBytes(bytes)}) weren’t finished. Select the same files or folder again and we’ll continue where you left off.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onResume} className="flex-1 sm:flex-none">Resume</Button>
        <Button variant="outline" onClick={onDiscard} className="flex-1 sm:flex-none">Discard</Button>
      </div>
    </Card>
  );
}
