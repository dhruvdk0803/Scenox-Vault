'use client';

import { useSearchParams } from 'next/navigation';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { PageHeader } from '@/components/ui/page-header';
import { PortalForm } from '../portals/portal-form';

export function PortalNewPage() {
  const clientId = useSearchParams().get('clientId') ?? undefined;
  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: 'Upload Portals', href: '/portals' }, { label: 'New portal' }]} />}
        title="New upload portal"
        description="Configure a secure link your client can use to upload files."
      />
      <PortalForm defaultClientId={clientId} />
    </>
  );
}
