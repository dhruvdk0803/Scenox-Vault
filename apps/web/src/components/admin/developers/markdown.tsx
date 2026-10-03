'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { CodeBlock } from './code-block';

/**
 * A deliberately small, safe markdown renderer: it parses text into plain data and emits React elements.
 * Nothing is ever injected as HTML, and link targets are restricted to http(s), mailto, anchors and site-relative paths.
 */

type Align = 'left' | 'center' | 'right' | undefined;
interface ListItem { text: string; children: Block[] }
type Block =
  | { type: 'heading'; level: number; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: string[]; align: Align[]; rows: string[][] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'hr' };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const isBlockStart = (line: string) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || LIST.test(line);

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const usedIds = new Map<string, number>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ type: 'code', lang: fence[2] ?? '', code: body.join('\n') });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const text = h[2]!;
      let id = slugify(text) || 'section';
      const n = usedIds.get(id) ?? 0;
      usedIds.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      blocks.push({ type: 'heading', level: h[1]!.length, text, id });
      i++;
      continue;
    }

    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^ {0,3}> ?/, ''));
      blocks.push({ type: 'quote', blocks: parseBlocks(body) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]!).map<Align>((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) rows.push(splitRow(lines[i++]!));
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    const li = LIST.exec(line);
    if (li) {
      const baseIndent = li[1]!.length;
      const ordered = /\d/.test(li[2]!);
      const start = ordered ? parseInt(li[2]!, 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (!m || m[1]!.length !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
        const text: string[] = [m[3]!];
        const nested: string[] = [];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (!l.trim()) {
            // blank line: continue the item only if the next non-blank line is indented deeper
            const next = lines.slice(i + 1).find((x) => x.trim());
            if (next && /^\s+/.test(next) && next.search(/\S/) > baseIndent) { nested.push(''); i++; continue; }
            break;
          }
          const indent = l.search(/\S/);
          if (indent > baseIndent) { nested.push(l); i++; continue; }
          if (indent === baseIndent && LIST.test(l)) break;
          if (isBlockStart(l)) break;
          text.push(l.trim()); // lazy continuation
          i++;
        }
        items.push({ text: text.join(' '), children: nested.length ? parseBlocks(dedent(nested)) : [] });
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // paragraph
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!) && !(lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-'))) para.push(lines[i++]!.trim());
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

function dedent(lines: string[]): string[] {
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)), Infinity);
  return Number.isFinite(min) ? lines.map((l) => l.slice(Math.min(min, l.length))) : lines;
}

// ───────────────────────── inline ─────────────────────────

const INLINE_SOURCE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*][\s\S]*?)\*\*|__([^_][\s\S]*?)__|\[((?:[^\[\]]|\[[^\]]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()\[\]]+[^\s<>()\[\].,;:!?'"])|\*([^*\s](?:[^*]*[^*\s])?)\*/;

export function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith('#') || (h.startsWith('/') && !h.startsWith('//'))) return h;
  try {
    const u = new URL(h);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const linkClass = 'font-medium text-primary underline underline-offset-2 hover:text-primary-hover';

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  const external = /^(https?:|mailto:)/.test(safe);
  return (
    <a href={safe} className={linkClass} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}

function renderInline(text: string, keyBase = 'i'): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  // A fresh regex per call: renderInline recurses (bold/link labels), and a shared global regex would lose its lastIndex.
  const re = new RegExp(INLINE_SOURCE.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index).replace(/\\([\\`*_{}\[\]()#+\-.!|<>])/g, '$1'));
    const key = `${keyBase}-${n++}`;
    if (m[2] !== undefined) {
      out.push(<code key={key} className="rounded-md border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-[0.85em] text-fg">{m[2].trim()}</code>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={key} className="font-semibold text-fg">{renderInline((m[3] ?? m[4])!, key)}</strong>);
    } else if (m[5] !== undefined) {
      out.push(<Link key={key} href={m[6]!}>{renderInline(m[5], key)}</Link>);
    } else if (m[7] !== undefined) {
      out.push(<Link key={key} href={m[7]}>{m[7]}</Link>);
    } else if (m[8] !== undefined) {
      out.push(<em key={key}>{renderInline(m[8], key)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last).replace(/\\([\\`*_{}\[\]()#+\-.!|<>])/g, '$1'));
  return out;
}

// ───────────────────────── render ─────────────────────────

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-2 text-2xl font-semibold tracking-tight',
  2: 'mt-10 border-b border-border pb-2 text-xl font-semibold tracking-tight',
  3: 'mt-8 text-base font-semibold tracking-tight',
  4: 'mt-6 text-sm font-semibold',
  5: 'mt-5 text-sm font-semibold text-fg-muted',
  6: 'mt-5 text-xs font-semibold uppercase tracking-wide text-fg-subtle',
};

function renderBlocks(blocks: Block[], keyBase: string): React.ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${keyBase}-${idx}`;
    switch (b.type) {
      case 'heading': {
        const Tag = `h${Math.min(b.level, 6)}` as 'h1';
        return (
          <Tag key={key} id={b.id} className={cn('scroll-mt-20 text-fg first:mt-0', HEADING_CLASS[b.level])}>
            {renderInline(b.text, key)}
          </Tag>
        );
      }
      case 'paragraph':
        return <p key={key} className="text-sm leading-6 text-fg-muted [&>strong]:text-fg">{renderInline(b.text, key)}</p>;
      case 'code':
        return <CodeBlock key={key} code={b.code} language={b.lang || 'text'} />;
      case 'hr':
        return <hr key={key} className="border-border" />;
      case 'quote':
        return <blockquote key={key} className="space-y-3 border-l-2 border-primary-soft-border bg-primary-soft/50 py-2 pl-4 pr-3">{renderBlocks(b.blocks, key)}</blockquote>;
      case 'list': {
        const Tag = (b.ordered ? 'ol' : 'ul') as 'ol';
        return (
          <Tag key={key} {...(b.ordered && b.start !== 1 ? { start: b.start } : {})} className={cn('space-y-1.5 pl-5 text-sm leading-6 text-fg-muted marker:text-fg-subtle', b.ordered ? 'list-decimal' : 'list-disc')}>
            {b.items.map((it, j) => (
              <li key={`${key}-${j}`} className="pl-1">
                {renderInline(it.text, `${key}-${j}`)}
                {it.children.length > 0 && <div className="mt-1.5 space-y-2">{renderBlocks(it.children, `${key}-${j}c`)}</div>}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead className="bg-surface-muted">
                <tr className="border-b border-border">
                  {b.header.map((c, j) => (
                    <th key={j} scope="col" className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-subtle" style={{ textAlign: b.align[j] ?? 'left' }}>{renderInline(c, `${key}-h${j}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border last:border-0">
                    {b.header.map((_, j) => (
                      <td key={j} className="px-3 py-2 align-top text-fg-muted" style={{ textAlign: b.align[j] ?? 'left' }}>{renderInline(r[j] ?? '', `${key}-${ri}-${j}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Headings (h2/h3) found in the document, for an "On this page" list. */
export function outline(blocks: Block[]): { id: string; text: string; level: number }[] {
  return blocks.flatMap((b) => (b.type === 'heading' && (b.level === 2 || b.level === 3) ? [{ id: b.id, text: b.text.replace(/[`*_]/g, ''), level: b.level }] : []));
}

export function Markdown({ blocks, className }: { blocks: Block[]; className?: string }) {
  return <div className={cn('space-y-4', className)}>{renderBlocks(blocks, 'md')}</div>;
}
