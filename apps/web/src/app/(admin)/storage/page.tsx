import { HardDrive } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Storage' };

export default function Page() {
  return (
    <>
      <PageHeader title="Storage" description="Storage usage and capacity." />
      <Card>
        <EmptyState icon={<HardDrive />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
