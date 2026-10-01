'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { UploadsTable } from '../uploads/uploads-table';

export function UploadsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const sessionId = sp.get('session');
  return (
    <>
      <PageHeader title="Uploads" description="Every upload session from your portals, with live progress for transfers in flight." />
      <UploadsTable
        sessionId={sessionId}
        onSessionChange={(id) => router.replace(id ? `${pathname}?session=${id}` : pathname, { scroll: false })}
      />
    </>
  );
}
