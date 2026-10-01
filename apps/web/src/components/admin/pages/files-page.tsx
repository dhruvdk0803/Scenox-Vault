'use client';

import { PageHeader } from '@/components/ui/page-header';
import { FilesExplorer } from '../files/files-explorer';

export function FilesPage() {
  return (
    <>
      <PageHeader title="Files" description="Browse, search and download everything your clients have uploaded." />
      <FilesExplorer />
    </>
  );
}
