import { Suspense } from 'react';
import { PortalNewPage } from '@/components/admin/pages/portal-new-page';

export const metadata = { title: 'New portal' };

export default function Page() {
  return (
    <Suspense>
      <PortalNewPage />
    </Suspense>
  );
}
