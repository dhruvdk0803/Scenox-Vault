import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Audit Log' };

export default function Page() {
  return (
    <>
      <PageHeader title="Audit Log" description="A tamper-evident record of administrative actions." />
      <Card>
        <EmptyState icon={<ScrollText />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
