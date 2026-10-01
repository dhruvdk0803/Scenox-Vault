import { LayoutDashboard } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Dashboard' };

export default function Page() {
  return (
    <>
      <PageHeader title="Dashboard" description="Overview of uploads, storage and recent activity." />
      <Card>
        <EmptyState icon={<LayoutDashboard />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
