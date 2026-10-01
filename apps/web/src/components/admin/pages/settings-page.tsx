'use client';

import { useQuery } from '@tanstack/react-query';
import type { SettingsDTO } from '@scenox/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { ErrorState } from '../query-state';
import { BrandingTab } from '../settings/branding-tab';
import { AccountTab, EmailTab, NotificationsTab, RetentionTab, SecurityTab, UploadDefaultsTab } from '../settings/other-tabs';

export function SettingsPage() {
  const canView = usePermission('settings.view');
  const canEdit = usePermission('settings.manage');
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api.get<SettingsDTO>('/settings', { signal }),
    enabled: canView,
  });

  return (
    <>
      <PageHeader title="Settings" description={canEdit ? 'Branding, notifications, security and defaults for your vault.' : 'View your vault’s configuration and manage your account.'} />
      <Tabs defaultValue={canView ? 'branding' : 'account'}>
        <TabsList aria-label="Settings sections">
          {canView && (
            <>
              <TabsTrigger value="branding">Branding</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
              <TabsTrigger value="retention">Retention</TabsTrigger>
              <TabsTrigger value="uploads">Upload defaults</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
            </>
          )}
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>
        {canView && (
          error && !data ? (
            <div className="pt-4"><Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load settings" /></Card></div>
          ) : isPending ? (
            <div className="space-y-4 pt-4"><Skeleton className="h-64 max-w-3xl" /></div>
          ) : (
            <>
              <TabsContent value="branding"><BrandingTab settings={data} canEdit={canEdit} /></TabsContent>
              <TabsContent value="notifications"><NotificationsTab settings={data} canEdit={canEdit} /></TabsContent>
              <TabsContent value="security"><SecurityTab settings={data} canEdit={canEdit} /></TabsContent>
              <TabsContent value="retention"><RetentionTab settings={data} canEdit={canEdit} /></TabsContent>
              <TabsContent value="uploads"><UploadDefaultsTab settings={data} canEdit={canEdit} /></TabsContent>
              <TabsContent value="email"><EmailTab settings={data} canEdit={canEdit} /></TabsContent>
            </>
          )
        )}
        <TabsContent value="account"><AccountTab /></TabsContent>
      </Tabs>
    </>
  );
}
