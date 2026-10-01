import { Suspense } from 'react';
import { ActivityPage } from '@/components/admin/pages/activity-page';

export const metadata = { title: 'Activity' };

export default function Page() {
  return (
    <Suspense>
      <ActivityPage />
    </Suspense>
  );
}
