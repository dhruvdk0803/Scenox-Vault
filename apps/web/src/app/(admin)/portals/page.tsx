import { Link2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Upload Portals' };

export default function Page() {
  return (
    <>
      <PageHeader title="Upload Portals" description="Secure upload links for your clients." />
      <Card>
        <EmptyState icon={<Link2 />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
