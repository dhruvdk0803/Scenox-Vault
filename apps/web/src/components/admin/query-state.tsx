'use client';

import { AlertTriangle } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/** Friendly inline error with retry, for failed queries. */
export function ErrorState({ error, onRetry, retrying, title = "Couldn't load this" }: { error: unknown; onRetry?: () => void; retrying?: boolean; title?: string }) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={title}
      description={errorMessage(error, 'Something went wrong while loading data.')}
      action={onRetry && <Button variant="outline" onClick={onRetry} loading={retrying}>Try again</Button>}
    />
  );
}
