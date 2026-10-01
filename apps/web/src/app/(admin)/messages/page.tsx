import { Suspense } from 'react';
import { MessagesPage } from '@/components/admin/pages/messages-page';

export const metadata = { title: 'Messages' };

export default function Page() {
  return (
    <Suspense>
      <MessagesPage />
    </Suspense>
  );
}
