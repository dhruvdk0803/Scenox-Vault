'use client';

import * as React from 'react';
import { Tabs as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Tabs = Primitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof Primitive.List>,
  React.ComponentPropsWithoutRef<typeof Primitive.List>
>(({ className, ...props }, ref) => (
  <Primitive.List ref={ref} className={cn('flex items-center gap-1 overflow-x-auto border-b border-border', className)} {...props} />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ className, ...props }, ref) => (
  <Primitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-fg-muted transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-fg',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, ...props }, ref) => (
  <Primitive.Content ref={ref} className={cn('pt-4 focus-visible:outline-2 focus-visible:outline-ring', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
