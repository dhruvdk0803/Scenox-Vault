import { Suspense } from 'react';
import { DevelopersPage } from '@/components/admin/pages/developers-page';

export const metadata = { title: 'Developers' };

export default function Page() {
  return (
    <Suspense>
      <DevelopersPage />
    </Suspense>
  );
}
