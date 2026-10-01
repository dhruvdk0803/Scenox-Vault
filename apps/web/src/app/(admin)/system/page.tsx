import { Suspense } from 'react';
import { SystemPage } from '@/components/admin/pages/system-page';

export const metadata = { title: 'System Health' };

export default function Page() {
  return (
    <Suspense>
      <SystemPage />
    </Suspense>
  );
}
