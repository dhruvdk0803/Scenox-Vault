import { Suspense } from 'react';
import { PortalDetailPage } from '@/components/admin/pages/portal-detail-page';

export const metadata = { title: 'Portal' };

export default function Page() {
  return (
    <Suspense>
      <PortalDetailPage />
    </Suspense>
  );
}
