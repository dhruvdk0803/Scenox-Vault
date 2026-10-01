import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/** Minimal fastify-plugin equivalent: skip encapsulation so decorators are visible app-wide. */
export default function fp<T extends FastifyPluginAsync>(plugin: T): T {
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  return plugin;
}
export type { FastifyInstance };
