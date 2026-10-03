'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BookOpen, KeyRound, Webhook } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiKeysTab } from '../developers/api-keys-tab';
import { DocsTab } from '../developers/docs-tab';
import { WebhooksTab } from '../developers/webhooks-tab';

const TABS = ['keys', 'webhooks', 'docs'] as const;
type Tab = (typeof TABS)[number];

export function DevelopersPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(fromUrl ?? '') ? (fromUrl as Tab) : 'keys';

  const setTab = React.useCallback(
    (next: string) => router.replace(next === 'keys' ? pathname : `${pathname}?tab=${next}`, { scroll: false }),
    [router, pathname],
  );

  return (
    <>
      <PageHeader title="Developers" description="API keys, webhooks and documentation for connecting Scenox Vault to your other tools and AI agents." />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Developer sections">
          <TabsTrigger value="keys"><KeyRound className="size-4" aria-hidden /> API keys</TabsTrigger>
          <TabsTrigger value="webhooks"><Webhook className="size-4" aria-hidden /> Webhooks</TabsTrigger>
          <TabsTrigger value="docs"><BookOpen className="size-4" aria-hidden /> Docs</TabsTrigger>
        </TabsList>
        <TabsContent value="keys"><ApiKeysTab /></TabsContent>
        <TabsContent value="webhooks"><WebhooksTab /></TabsContent>
        <TabsContent value="docs"><DocsTab onCreateKey={() => setTab('keys')} /></TabsContent>
      </Tabs>
    </>
  );
}
