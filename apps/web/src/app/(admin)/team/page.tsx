import { UserCog } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Team' };

export default function Page() {
  return (
    <>
      <PageHeader title="Team" description="Invite teammates and manage roles." />
      <Card>
        <EmptyState icon={<UserCog />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
