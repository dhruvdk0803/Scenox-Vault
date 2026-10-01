import { Suspense } from 'react';
import { StoragePage } from '@/components/admin/pages/storage-page';

export const metadata = { title: 'Storage' };

export default function Page() {
  return (
    <Suspense>
      <StoragePage />
    </Suspense>
  );
}
