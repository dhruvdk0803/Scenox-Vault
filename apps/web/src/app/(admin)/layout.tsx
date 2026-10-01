'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { ApiClientError } from '@/lib/api';
import { useMe } from '@/lib/hooks/use-me';
import { AdminShell, AdminShellSkeleton } from '@/components/layout/admin-shell';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { data: me, error, isPending, refetch, isFetching } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const unauthorized = error instanceof ApiClientError && error.status === 401;

  React.useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [unauthorized, router, pathname]);

  if (me) return <AdminShell me={me}>{children}</AdminShell>;
  if (isPending || unauthorized) return <AdminShellSkeleton />;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <EmptyState
        icon={<AlertTriangle />}
        title="Can't reach the server"
        description={error instanceof ApiClientError ? error.message : 'Something went wrong while loading your session.'}
        action={<Button onClick={() => refetch()} loading={isFetching}>Try again</Button>}
      />
    </main>
  );
}
