import { Settings } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Settings' };

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" description="Branding, security and workspace preferences." />
      <Card>
        <EmptyState icon={<Settings />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
