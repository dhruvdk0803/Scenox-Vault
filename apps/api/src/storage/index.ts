import { config } from '../config';
import { LocalStorage } from './local';
import type { StorageService } from './types';

export * from './types';

let instance: (StorageService & { init?: () => Promise<void> }) | null = null;

export function getStorage(): StorageService {
  if (!instance) {
    const cfg = config();
    switch (cfg.storage.driver) {
      case 'local':
        instance = new LocalStorage(cfg.storage.path);
        break;
      default:
        throw new Error(`Unsupported storage driver: ${cfg.storage.driver}`);
    }
  }
  return instance;
}

export async function initStorage() {
  const s = getStorage() as StorageService & { init?: () => Promise<void> };
  await s.init?.();
  return s;
}

/** Test helper */
export function resetStorage() {
  instance = null;
}
