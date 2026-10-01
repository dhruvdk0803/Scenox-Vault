import { Suspense } from 'react';
import { TeamPage } from '@/components/admin/pages/team-page';

export const metadata = { title: 'Team' };

export default function Page() {
  return (
    <Suspense>
      <TeamPage />
    </Suspense>
  );
}
