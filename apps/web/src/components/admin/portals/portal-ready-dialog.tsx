'use client';

import { CheckCircle2, ExternalLink, Mail } from 'lucide-react';
import type { PortalDTO } from '@scenox/shared';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useClientOptions } from '@/lib/hooks/use-options';
import { portalMailto } from '../portal-link-card';

export function PortalReadyDialog({ portal, onDone }: { portal: PortalDTO | null; onDone: () => void }) {
  const clients = useClientOptions(!!portal);
  const clientEmail = portal ? clients.data?.items.find((c) => c.id === portal.clientId)?.email : null;
  return (
    <Dialog open={!!portal} onOpenChange={(o) => !o && onDone()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-success-bg text-success"><CheckCircle2 className="size-5" aria-hidden /></div>
          <DialogTitle>Portal ready</DialogTitle>
          <DialogDescription>
            Share this secure link with {portal?.clientName ?? 'your client'}. Anyone with the link can upload, so send it only to people you trust.
          </DialogDescription>
        </DialogHeader>
        {portal?.url ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <p className="break-all font-mono text-base font-medium text-fg">{portal.url}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton value={portal.url} label="Copy link" showLabel variant="primary" />
              <Button variant="outline" size="sm" asChild>
                <a href={portal.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden /> Open portal</a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href={portalMailto(portal, clientEmail)}><Mail aria-hidden /> Email link</a>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-fg-muted">The link is available on the portal page.</p>
        )}
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
