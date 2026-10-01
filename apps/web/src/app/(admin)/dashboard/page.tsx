import { Suspense } from 'react';
import { DashboardPage } from '@/components/admin/pages/dashboard-page';

export const metadata = { title: 'Dashboard' };

export default function Page() {
  return (
    <Suspense>
      <DashboardPage />
    </Suspense>
  );
}
