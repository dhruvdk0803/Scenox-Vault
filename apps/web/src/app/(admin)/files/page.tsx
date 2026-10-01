import { FolderOpen } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card } from '@/components/ui/card';

export const metadata = { title: 'Files' };

export default function Page() {
  return (
    <>
      <PageHeader title="Files" description="Browse and download received files." />
      <Card>
        <EmptyState icon={<FolderOpen />} title="Coming soon" description="This section is being built." />
      </Card>
    </>
  );
}
