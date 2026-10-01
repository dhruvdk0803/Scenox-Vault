import * as React from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { Skeleton } from './skeleton';

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  subText?: React.ReactNode;
  icon?: React.ReactNode;
  /** Percent change; positive = up. `trendGoodWhen` decides colour (e.g. errors: 'down'). */
  trend?: { value: number; label?: string; goodWhen?: 'up' | 'down' };
  loading?: boolean;
  className?: string;
}

export function StatCard({ label, value, subText, icon, trend, loading, className }: StatCardProps) {
  const up = (trend?.value ?? 0) >= 0;
  const good = trend ? (trend.goodWhen ?? 'up') === (up ? 'up' : 'down') : true;
  const TrendIcon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className={cn('flex flex-col gap-3 p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg-muted">{label}</span>
        {icon && <span className="text-fg-subtle [&_svg]:size-4" aria-hidden>{icon}</span>}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="text-2xl font-semibold tracking-tight tabular-nums text-fg">{value}</div>
      )}
      {(subText || trend) && !loading && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
          {trend && (
            <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', good ? 'text-success' : 'text-danger')}>
              <TrendIcon className="size-3.5" aria-hidden />
              {Math.abs(trend.value).toFixed(1)}%
              <span className="sr-only">{up ? ' increase' : ' decrease'}</span>
            </span>
          )}
          {trend?.label && <span>{trend.label}</span>}
          {subText && <span className="tabular-nums">{subText}</span>}
        </div>
      )}
    </Card>
  );
}
