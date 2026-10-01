# Scenox Vault — Design System

Calm, premium, Linear/Vercel-like. Neutral canvas, white cards, 1px zinc borders, 8–12px radius, near-flat shadows, Geist Sans, 150ms transitions only. Light mode only.

## Tokens (`src/app/globals.css`)
CSS variables on `:root`, exposed to Tailwind via `@theme inline` (`bg-surface`, `text-fg-muted`, `border-border` …).

| Group | Tokens |
| --- | --- |
| Surfaces | `background`, `surface`, `surface-muted`, `border`, `border-strong` |
| Text | `fg`, `fg-muted`, `fg-subtle` |
| Brand | `primary`, `primary-foreground`, `primary-hover`, `primary-soft`, `primary-soft-border`, `primary-soft-fg` (soft/hover derive via `color-mix`, so overriding `--primary` at runtime re-themes everything) |
| Status | `success` `warning` `danger` `info` `neutral`, each with `-bg` and `-border` (text colour is the bare name); plus `danger-solid` for filled destructive buttons |
| Focus | `ring` (used as 2px `outline` on `:focus-visible`) |
| Radius | `rounded-sm/md/lg/xl` = 6/8/12/16px (controls md, cards lg, dialogs xl) |
| Shadow | `shadow-xs/sm/md/lg` |
| Type | Geist Sans body 14px/22px; `text-xs…3xl`; use `tabular-nums` for sizes, speeds, counts |

Runtime branding: `document.documentElement.style.setProperty('--primary', '#0f766e')` (and `--primary-foreground` if needed for contrast).

## Rules
- Status never relies on colour alone: use `<StatusBadge>` (icon + label).
- Icon-only buttons need `aria-label`; wrap in `<Tooltip>` when helpful.
- Forms: `<Field label hint error><Input/></Field>` wires ids/aria.
- Tables: `<DataTable>` + `<Pagination>` + `<FilterBar>`; server-side sort/paging via `onSortChange`.
- Page skeleton: `<PageHeader title description actions />` then content in `<Card>`s.
- Format values with `@scenox/shared` (`formatBytes`, `formatSpeed`, `formatDuration`, `formatNumber`).
- Import primitives from `@/components/ui` (barrel) and `cn` from `@/lib/utils`.
