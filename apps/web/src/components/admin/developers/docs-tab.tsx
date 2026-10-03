'use client';

import * as React from 'react';
import { BookOpen, Bot, KeyRound, ListTree, Sparkles } from 'lucide-react';
import { useDeveloperDocs, useOrigin } from '@/lib/hooks/use-developer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '../query-state';
import { CopyField } from './code-block';
import { Markdown, outline, parseMarkdown } from './markdown';

function AgentCard({ onCreateKey }: { onCreateKey?: () => void }) {
  const origin = useOrigin() || 'https://your-vault.example.com';
  const docsUrl = `${origin}/api/docs`;
  const prompt = `Read ${docsUrl} and use API key svk_… to push client X's product images to Shopify`;
  return (
    <Card className="overflow-hidden border-primary-soft-border">
      <div className="flex items-start gap-3 border-b border-primary-soft-border bg-primary-soft px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary-soft-border bg-surface text-primary"><Bot className="size-4.5" aria-hidden /></div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-primary-soft-fg">Give this to your AI agent</h2>
          <p className="mt-0.5 text-sm text-fg-muted">The developer guide is plain markdown at a public URL, so an AI agent can read it and start working with your vault.</p>
        </div>
      </div>
      <div className="grid gap-5 p-5">
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-fg-muted">Docs URL</p>
          <CopyField value={docsUrl} label="Copy docs URL" />
        </div>
        <ol className="grid gap-3 text-sm text-fg-muted sm:grid-cols-3">
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-fg">1</span>
            <span>Create a <strong className="font-medium text-fg">Read &amp; write</strong> API key on the <strong className="font-medium text-fg">API keys</strong> tab.{onCreateKey && <> <Button variant="link" className="align-baseline text-sm" onClick={onCreateKey}><KeyRound aria-hidden /> Go to API keys</Button></>}</span>
          </li>
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-fg">2</span>
            <span>Give your agent the docs URL and the key. Keep the key out of shared chats and source code.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-fg">3</span>
            <span>Tell it what to do, in plain English. Revoke the key whenever you&apos;re done.</span>
          </li>
        </ol>
        <div className="grid gap-1.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted"><Sparkles className="size-3.5" aria-hidden /> Example prompt</p>
          <div className="flex items-start gap-1 rounded-lg border border-border bg-surface-muted py-1.5 pl-3 pr-1">
            <p className="min-w-0 flex-1 py-1 text-sm italic leading-5 text-fg">“{prompt}”</p>
            <CopyButton value={prompt} label="Copy example prompt" />
          </div>
        </div>
      </div>
    </Card>
  );
}

function DocsBody() {
  const { data, isPending, error, refetch, isFetching } = useDeveloperDocs();
  const blocks = React.useMemo(() => (data ? parseMarkdown(data) : []), [data]);
  const toc = React.useMemo(() => outline(blocks), [blocks]);

  if (error && !data) return <Card><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load the developer guide" /></Card>;
  if (isPending) {
    return (
      <Card className="space-y-3 p-6" aria-busy="true">
        <Skeleton className="h-7 w-1/3" />
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }
  if (blocks.length === 0) return <Card><EmptyState icon={<BookOpen />} title="The guide is empty" description="The server returned no documentation." /></Card>;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_14rem]">
      <Card className="min-w-0 p-5 sm:p-8">
        <article aria-label="Developer guide"><Markdown blocks={blocks} /></article>
      </Card>
      {toc.length > 0 && (
        <nav aria-label="On this page" className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] overflow-y-auto lg:block">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle"><ListTree className="size-3.5" aria-hidden /> On this page</p>
          <ul className="space-y-0.5 border-l border-border">
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`} className={`-ml-px block border-l border-transparent py-1 pr-2 text-sm text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg ${t.level === 3 ? 'pl-6 text-[13px]' : 'pl-3'}`}>{t.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export function DocsTab({ onCreateKey }: { onCreateKey?: () => void }) {
  return (
    <div className="space-y-6">
      <AgentCard onCreateKey={onCreateKey} />
      <DocsBody />
    </div>
  );
}
