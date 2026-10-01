import { Suspense } from 'react';
import { FilesPage } from '@/components/admin/pages/files-page';

export const metadata = { title: 'Files' };

export default function Page() {
  return (
    <Suspense>
      <FilesPage />
    </Suspense>
  );
}
