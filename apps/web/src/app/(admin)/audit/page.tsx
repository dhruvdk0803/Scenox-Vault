import { Suspense } from 'react';
import { AuditPage } from '@/components/admin/pages/audit-page';

export const metadata = { title: 'Audit Log' };

export default function Page() {
  return (
    <Suspense>
      <AuditPage />
    </Suspense>
  );
}
