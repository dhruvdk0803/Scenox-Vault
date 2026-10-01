import { Suspense } from 'react';
import { UploadsPage } from '@/components/admin/pages/uploads-page';

export const metadata = { title: 'Uploads' };

export default function Page() {
  return (
    <Suspense>
      <UploadsPage />
    </Suspense>
  );
}
