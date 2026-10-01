import { UploadCloud } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Uploads' };

export default function Page() {
  return (
    <>
      <PageHeader title="Uploads" description="Monitor uploads in progress and their history." />
      <Card>
        <EmptyState icon={<UploadCloud />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
