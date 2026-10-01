import { Suspense } from 'react';
import { ClientDetailPage } from '@/components/admin/pages/client-detail-page';

export const metadata = { title: 'Client' };

export default function Page() {
  return (
    <Suspense>
      <ClientDetailPage />
    </Suspense>
  );
}
