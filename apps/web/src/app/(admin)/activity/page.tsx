import { Activity } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Activity' };

export default function Page() {
  return (
    <>
      <PageHeader title="Activity" description="A timeline of everything happening in your vault." />
      <Card>
        <EmptyState icon={<Activity />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
