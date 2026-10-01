import { Suspense } from 'react';
import { ClientsPage } from '@/components/admin/pages/clients-page';

export const metadata = { title: 'Clients' };

export default function Page() {
  return (
    <Suspense>
      <ClientsPage />
    </Suspense>
  );
}
