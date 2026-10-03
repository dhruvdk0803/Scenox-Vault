'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CopyField } from './code-block';

/**
 * Shows a secret exactly once. The secret lives only in the caller's React state (clear it in `onClose`);
 * it is never persisted, logged or placed in the query cache.
 */
export function SecretDialog({
  secret, title, description, secretLabel, children, onClose,
}: {
  secret: string | null;
  title: string;
  description: React.ReactNode;
  secretLabel: string;
  children?: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-xl"
        // Don't let a stray click outside throw away the only copy of the secret.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p><span className="font-semibold">Copy it now — you won&apos;t see it again.</span> Store it in a password manager or your integration&apos;s secret settings.</p>
        </div>
        {secret !== null && (
          <div className="grid gap-1.5">
            <p className="text-xs font-medium text-fg-muted">{secretLabel}</p>
            <CopyField value={secret} label={`Copy ${secretLabel.toLowerCase()}`} />
          </div>
        )}
        {children}
        <DialogFooter>
          <Button onClick={onClose}>I&apos;ve copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
