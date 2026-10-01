'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, FileText, Link2, Mail, PauseCircle, Pencil, PlayCircle, Plus, Phone, Trash2, Building2, MessagesSquare, UserX } from 'lucide-react';
import { formatNumber, type ActivityDTO, type ClientDTO, type Paginated, type PortalDTO } from '@scenox/shared';
import { api, ApiClientError, qs } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { useInbox } from '@/lib/hooks/use-messages';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Pagination } from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { StorageMeter } from '@/components/ui/storage-meter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ActivityFeed } from '../activity-feed';
import { ClientDeleteDialog, ClientFormDialog, useToggleClientStatus } from '../clients/client-dialogs';
import { FileBrowser } from '../files/file-browser';
import { InboxList, UnreadBadge } from '../messages/inbox-list';
import { PortalCard } from '../portals/portal-card';
import { ErrorState } from '../query-state';
import { formatDateTime } from '../relative-time';
import { UploadsTable } from '../uploads/uploads-table';

function ClientPortals({ clientId, canCreate }: { clientId: string; canCreate: boolean }) {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.portals.list({ clientId, pageSize: 100 }),
    queryFn: ({ signal }) => api.get<Paginated<PortalDTO>>(`/portals${qs({ clientId, pageSize: 100 })}`, { signal }),
  });
  if (error && !data) return <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load portals" /></Card>;
  if (isPending) return <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-44" />)}</div>;
  if (data.items.length === 0)
    return (
      <Card>
        <EmptyState
          icon={<Link2 />}
          title="No upload portals yet"
          description="Create a portal to give this client a secure link for uploading files."
          action={canCreate ? <Button asChild><Link href={`/portals/new?clientId=${clientId}`}><Plus aria-hidden /> Create upload portal</Link></Button> : undefined}
        />
      </Card>
    );
  return <div className="grid gap-4 md:grid-cols-2">{data.items.map((p) => <PortalCard key={p.id} portal={p} />)}</div>;
}

function ClientMessages({ clientId }: { clientId: string }) {
  const { data, isPending, error, refetch, isFetching } = useInbox();
  const threads = React.useMemo(() => (data?.items ?? []).filter((t) => t.clientId === clientId), [data, clientId]);
  if (error && !data) return <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load messages" /></Card>;
  if (isPending) return <Card><div className="space-y-4 p-4">{Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div></Card>;
  if (threads.length === 0)
    return <Card><EmptyState icon={<MessagesSquare />} title="No messages yet" description="When this client writes to you from one of their portals, the conversation appears here." /></Card>;
  return <Card className="overflow-hidden"><InboxList threads={threads} selectedPortalId={null} /></Card>;
}

function ClientActivity({ clientId }: { clientId: string }) {
  const [page, setPage] = React.useState(1);
  const params = { clientId, page, pageSize: 25 };
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.activity(params),
    queryFn: ({ signal }) => api.get<Paginated<ActivityDTO>>(`/activity${qs(params)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardContent className="space-y-4">
        {error && !data ? (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load activity" />
        ) : (
          <>
            <ActivityFeed items={data?.items} loading={isPending} grouped showClient={false} empty={<EmptyState icon={<Activity />} title="No activity yet" description="Events for this client will show up here." />} />
            {data && data.total > 25 && <Pagination page={page} pageSize={25} total={data.total} onPageChange={setPage} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('clients.manage');
  const canDelete = usePermission('files.delete');
  const canPortals = usePermission('portals.manage');
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ClientDTO | null>(null);
  const toggle = useToggleClientStatus();
  const { data: inbox } = useInbox();
  const unreadMessages = (inbox?.items ?? []).filter((t) => t.clientId === id).reduce((n, t) => n + t.unread, 0);

  const { data: client, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.clients.detail(id),
    queryFn: ({ signal }) => api.get<ClientDTO>(`/clients/${id}`, { signal }),
  });

  if (error && !client) {
    const notFound = error instanceof ApiClientError && error.status === 404;
    return (
      <div className="rounded-lg border border-border bg-surface">
        {notFound ? (
          <EmptyState icon={<UserX />} title="Client not found" description="This client may have been deleted." action={<Button asChild variant="outline"><Link href="/clients">Back to clients</Link></Button>} />
        ) : (
          <ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load this client" />
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: 'Clients', href: '/clients' }, { label: client?.name ?? '…' }]} />}
        title={
          isPending ? <Skeleton className="h-8 w-56" /> : (
            <span className="flex items-center gap-3">
              <span className="truncate">{client.name}</span>
              <StatusBadge kind="client" status={client.status} className="shrink-0" />
            </span>
          )
        }
        description={client?.company ?? undefined}
        actions={
          client && (
            <>
              {canPortals && <Button asChild><Link href={`/portals/new?clientId=${client.id}`}><Plus aria-hidden /> Create portal</Link></Button>}
              {canManage && <Button variant="outline" onClick={() => setEditOpen(true)}><Pencil aria-hidden /> Edit</Button>}
              {canManage && (
                <Button variant="outline" onClick={() => toggle.mutate(client)} loading={toggle.isPending}>
                  {client.status === 'active' ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />}
                  {client.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              )}
              {canManage && canDelete && (
                <Button variant="outline" className="text-danger hover:text-danger" onClick={() => setDeleting(client)}><Trash2 aria-hidden /> Delete</Button>
              )}
            </>
          )
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Storage" loading={isPending} value={client ? <StorageSummary client={client} /> : null} className="sm:col-span-2 xl:col-span-1" />
        <StatCard label="Files" loading={isPending} value={formatNumber(client?.fileCount)} />
        <StatCard label="Uploads" loading={isPending} value={formatNumber(client?.uploadCount)} />
        <StatCard label="Portals" loading={isPending} value={formatNumber(client?.portalCount)} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList aria-label="Client sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="portals">Portals</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="uploads">Uploads</TabsTrigger>
          <TabsTrigger value="messages">Messages <UnreadBadge count={unreadMessages} /></TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent>
                <h2 className="mb-3 text-sm font-semibold">Contact</h2>
                {client ? (
                  <dl className="space-y-3 text-sm">
                    <div className="flex items-center gap-3"><Building2 className="size-4 text-fg-subtle" aria-hidden /><dt className="sr-only">Company</dt><dd>{client.company ?? <span className="text-fg-subtle">No company</span>}</dd></div>
                    <div className="flex items-center gap-3"><Mail className="size-4 text-fg-subtle" aria-hidden /><dt className="sr-only">Email</dt><dd>{client.email ? <a href={`mailto:${client.email}`} className="underline-offset-2 hover:underline">{client.email}</a> : <span className="text-fg-subtle">No email</span>}</dd></div>
                    <div className="flex items-center gap-3"><Phone className="size-4 text-fg-subtle" aria-hidden /><dt className="sr-only">Phone</dt><dd>{client.phone ?? <span className="text-fg-subtle">No phone</span>}</dd></div>
                    <div className="flex items-center gap-3"><FileText className="size-4 text-fg-subtle" aria-hidden /><dt className="text-fg-subtle">Created</dt><dd className="tabular-nums">{formatDateTime(client.createdAt)}</dd></div>
                  </dl>
                ) : <Skeleton className="h-24" />}
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <h2 className="mb-3 text-sm font-semibold">Notes</h2>
                {client ? (client.notes ? <p className="whitespace-pre-wrap text-sm text-fg">{client.notes}</p> : <p className="text-sm text-fg-subtle">No internal notes.</p>) : <Skeleton className="h-16" />}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="portals"><ClientPortals clientId={id} canCreate={canPortals} /></TabsContent>
        <TabsContent value="files"><FileBrowser clientId={id} /></TabsContent>
        <TabsContent value="uploads"><UploadsTable fixedClientId={id} pageSize={25} /></TabsContent>
        <TabsContent value="messages"><ClientMessages clientId={id} /></TabsContent>
        <TabsContent value="activity"><ClientActivity clientId={id} /></TabsContent>
      </Tabs>

      <ClientFormDialog open={editOpen} onOpenChange={setEditOpen} client={client} />
      <ClientDeleteDialog client={deleting} onOpenChange={(o) => !o && setDeleting(null)} onDeleted={() => router.replace('/clients')} />
    </>
  );
}

function StorageSummary({ client }: { client: ClientDTO }) {
  // StatCard's value slot is text-2xl; keep the meter compact and readable.
  return <StorageMeter usedBytes={client.storageUsedBytes} limitBytes={client.quotaBytes} className="text-base font-normal" />;
}
