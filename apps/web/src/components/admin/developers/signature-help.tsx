'use client';

import { ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CodeBlock } from './code-block';

const NODE_SNIPPET = `import crypto from 'node:crypto';

// rawBody must be the exact bytes received (a string or Buffer), not re-serialised JSON.
export function verifyScenoxSignature(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map((p) => p.trim().split('=')),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;

  // Reject old timestamps to block replayed requests.
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${t}.\${rawBody}\`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express example:
// app.post('/hooks/scenox', express.raw({ type: 'application/json' }), (req, res) => {
//   const ok = verifyScenoxSignature(req.body, req.get('X-Scenox-Signature'), process.env.SCENOX_WEBHOOK_SECRET);
//   if (!ok) return res.status(400).send('bad signature');
//   const event = JSON.parse(req.body); // { id, event, createdAt, data }
//   res.sendStatus(200);
// });`;

function Hdr({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[13rem_1fr] sm:gap-3">
      <dt><code className="font-mono text-[13px] font-medium text-fg">{name}</code></dt>
      <dd className="text-sm text-fg-muted">{children}</dd>
    </div>
  );
}

/** Static "how to verify a delivery" card. */
export function SignatureHelp() {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary-soft-border bg-primary-soft text-primary"><ShieldCheck className="size-4.5" aria-hidden /></div>
        <div>
          <h2 className="text-sm font-semibold">Verifying signatures</h2>
          <p className="mt-0.5 text-sm text-fg-muted">Every delivery is signed with your webhook&apos;s secret. Check the signature before trusting a request.</p>
        </div>
      </div>
      <div className="grid gap-5 p-5">
        <dl className="grid gap-2.5">
          <Hdr name="X-Scenox-Event">The event name, e.g. <code className="font-mono text-xs">file.ready</code>.</Hdr>
          <Hdr name="X-Scenox-Delivery">A unique delivery id. Use it to ignore duplicates.</Hdr>
          <Hdr name="X-Scenox-Signature"><code className="break-all font-mono text-xs">t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256&gt;</code></Hdr>
        </dl>
        <p className="text-sm text-fg-muted">
          Compute <code className="rounded bg-surface-muted px-1 font-mono text-xs">HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;raw request body&gt;&quot;)</code> as hex, using the signing secret exactly as shown when you created the webhook (including the <code className="font-mono text-xs">whsec_</code> prefix), and compare it to <code className="font-mono text-xs">v1</code> in constant time.
        </p>
        <CodeBlock language="javascript" label="Copy snippet" code={NODE_SNIPPET} maxHeight="26rem" />
      </div>
    </Card>
  );
}
