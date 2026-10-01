import { HeartPulse } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'System Health' };

export default function Page() {
  return (
    <>
      <PageHeader title="System Health" description="Service status and diagnostics." />
      <Card>
        <EmptyState icon={<HeartPulse />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
