'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Link2Off, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react';
import type { PortalDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toaster';

/** Secure link display for a portal: copy, open, regenerate (with warning), disable/enable. */
export function PortalLinkCard({ portal }: { portal: PortalDTO }) {
  const canManage = usePermission('portals.manage');
  const qc = useQueryClient();
  const [confirmRegen, setConfirmRegen] = React.useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
  };

  const toggle = useMutation({
    mutationFn: () => api.patch<PortalDTO>(`/portals/${portal.id}`, { status: portal.storedStatus === 'active' ? 'disabled' : 'active' }),
    onSuccess: (p) => {
      toast.success(p.storedStatus === 'active' ? 'Portal enabled' : 'Portal disabled', { description: p.storedStatus === 'active' ? 'Clients can upload again.' : 'The link no longer accepts uploads.' });
      invalidate();
    },
    onError: (e) => toast.error("Couldn't update the portal", { description: errorMessage(e) }),
  });

  const regenerate = async () => {
    try {
      await api.post<PortalDTO>(`/portals/${portal.id}/regenerate`);
      toast.success('New link generated', { description: 'The previous link no longer works.' });
      invalidate();
    } catch (e) {
      toast.error("Couldn't regenerate the link", { description: errorMessage(e) });
      throw e;
    }
  };

  const enabled = portal.storedStatus === 'active';

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Secure upload link</h2>
        <StatusBadge kind="portal" status={portal.status} />
      </div>
      {portal.url ? (
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface-muted py-1 pl-3 pr-1">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={portal.url}>{portal.url}</code>
          <CopyButton value={portal.url} label="Copy upload link" />
          <Button variant="ghost" size="icon" asChild>
            <a href={portal.url} target="_blank" rel="noopener noreferrer" aria-label="Open portal in a new tab">
              <ExternalLink aria-hidden />
            </a>
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg p-3 text-sm text-warning">
          <Link2Off className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>The link can&apos;t be displayed (token {portal.tokenPreview}…). Regenerate the link to get a fresh one.</p>
        </div>
      )}
      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setConfirmRegen(true)}>
            <RefreshCw aria-hidden /> Regenerate link
          </Button>
          <Button variant="outline" size="sm" onClick={() => toggle.mutate()} loading={toggle.isPending}>
            {enabled ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />}
            {enabled ? 'Disable portal' : 'Enable portal'}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmRegen}
        onOpenChange={setConfirmRegen}
        title="Regenerate secure link?"
        description="The current link will stop working immediately. Anyone who still has it will need the new link, so share it with your client again."
        confirmLabel="Regenerate link"
        destructive
        onConfirm={regenerate}
      />
    </Card>
  );
}

/** mailto: link with a prefilled subject/body for sending a portal link. */
export function portalMailto(portal: Pick<PortalDTO, 'name' | 'clientName' | 'url'>, to?: string | null): string {
  const subject = `Secure upload link: ${portal.name}`;
  const body = `Hi ${portal.clientName},\n\nPlease use this secure link to upload your files:\n\n${portal.url ?? ''}\n\nThank you!`;
  return `mailto:${to ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
