import { Users } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Clients' };

export default function Page() {
  return (
    <>
      <PageHeader title="Clients" description="Manage the clients who send you files." />
      <Card>
        <EmptyState icon={<Users />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
