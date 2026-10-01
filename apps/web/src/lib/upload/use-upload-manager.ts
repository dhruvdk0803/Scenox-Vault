'use client';

import * as React from 'react';
import { EMPTY_SNAPSHOT, UploadManager, type UploadManagerOptions } from './manager';
import type { UploadSnapshot } from './types';

/**
 * Creates one UploadManager per mount (options are read once) and subscribes to its throttled snapshots.
 * Online/offline events are wired for the lifetime of the component.
 */
export function useUploadManager(options: UploadManagerOptions | (() => UploadManagerOptions)): { manager: UploadManager; snapshot: UploadSnapshot } {
  const [manager] = React.useState(() => new UploadManager(typeof options === 'function' ? options() : options));
  React.useEffect(() => manager.attach(), [manager]);
  React.useEffect(() => () => manager.dispose(), [manager]);
  const snapshot = React.useSyncExternalStore(manager.subscribe, manager.getSnapshot, () => EMPTY_SNAPSHOT);
  return { manager, snapshot };
}
