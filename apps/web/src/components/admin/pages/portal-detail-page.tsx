'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, LinkIcon, Trash2 } from 'lucide-react';
import { formatNumber, type PortalDTO } from '@scenox/shared';
import { api, ApiClientError } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { StorageMeter } from '@/components/ui/storage-meter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toaster';
import { useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '@/lib/api';
import { FileBrowser } from '../files/file-browser';
import { PortalLinkCard } from '../portal-link-card';
import { PortalForm } from '../portals/portal-form';
import { PortalLogoCard } from '../portals/portal-logo-card';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';
import { UploadsTable } from '../uploads/uploads-table';

export function PortalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const canManage = usePermission('portals.manage');
  const canDelete = usePermission('files.delete');
  const [deleting, setDeleting] = React.useState(false);

  const { data: portal, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.portals.detail(id),
    queryFn: ({ signal }) => api.get<PortalDTO>(`/portals/${id}`, { signal }),
  });

  if (error && !portal) {
    const notFound = error instanceof ApiClientError && error.status === 404;
    return (
      <div className="rounded-lg border border-border bg-surface">
        {notFound ? (
          <EmptyState icon={<LinkIcon />} title="Portal not found" description="This portal may have been deleted." action={<Button asChild variant="outline"><Link href="/portals">Back to portals</Link></Button>} />
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load this portal" />
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: 'Upload Portals', href: '/portals' }, { label: portal?.name ?? '…' }]} />}
        title={
          isPending ? <Skeleton className="h-8 w-56" /> : (
            <span className="flex items-center gap-3"><span className="truncate">{portal.name}</span><StatusBadge kind="portal" status={portal.status} className="shrink-0" /></span>
          )
        }
        description={portal && <>For <Link href={`/clients/${portal.clientId}`} className="font-medium text-fg underline-offset-2 hover:underline">{portal.clientName}</Link></>}
        actions={portal && (
          <>
            {portal.url && <Button variant="outline" asChild><a href={portal.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden /> Open portal</a></Button>}
            {canManage && canDelete && <Button variant="outline" className="text-danger hover:text-danger" onClick={() => setDeleting(true)}><Trash2 aria-hidden /> Delete</Button>}
          </>
        )}
      />

      {isPending ? <Skeleton className="mb-6 h-32" /> : <div className="mb-6"><PortalLinkCard portal={portal} /></div>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Files" loading={isPending} value={formatNumber(portal?.fileCount)} />
        <StatCard label="Storage" loading={isPending} value={portal ? <StorageMeter usedBytes={portal.storageUsedBytes} limitBytes={portal.maxTotalBytes} className="text-base font-normal" /> : null} />
        <StatCard label="Upload sessions" loading={isPending} value={formatNumber(portal?.sessionCount)} />
        <StatCard label="Last accessed" loading={isPending} value={<span className="text-lg"><RelativeTime date={portal?.lastAccessedAt} fallback="Never" /></span>} />
      </div>

      <Tabs defaultValue="settings">
        <TabsList aria-label="Portal sections">
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="space-y-6">
          {portal ? (
            <>
              <div className="mx-auto max-w-3xl"><PortalLogoCard portal={portal} /></div>
              <PortalForm key={portal.updatedAt} portal={portal} />
            </>
          ) : <Skeleton className="h-96" />}
        </TabsContent>
        <TabsContent value="sessions"><UploadsTable fixedPortalId={id} pageSize={10} filters={false} /></TabsContent>
        <TabsContent value="files">{portal && <FileBrowser clientId={portal.clientId} portalId={portal.id} />}</TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete portal?"
        description={portal ? <>This will permanently delete <strong>{portal.name}</strong> and all {formatNumber(portal.fileCount)} files uploaded through it. The link will stop working immediately.</> : undefined}
        requireText={portal?.name}
        confirmLabel="Delete portal"
        destructive
        onConfirm={async () => {
          try {
            await api.delete(`/portals/${id}`);
            toast.success('Portal deleted');
            void qc.invalidateQueries({ queryKey: queryKeys.portals.all });
            void qc.invalidateQueries({ queryKey: queryKeys.files.all });
            void qc.invalidateQueries({ queryKey: queryKeys.clients.all });
            router.replace('/portals');
          } catch (e) {
            toast.error("Couldn't delete the portal", { description: errorMessage(e) });
            throw e;
          }
        }}
      />
    </>
  );
}
