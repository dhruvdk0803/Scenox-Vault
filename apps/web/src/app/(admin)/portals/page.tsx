import { Suspense } from 'react';
import { PortalsPage } from '@/components/admin/pages/portals-page';

export const metadata = { title: 'Upload Portals' };

export default function Page() {
  return (
    <Suspense>
      <PortalsPage />
    </Suspense>
  );
}
