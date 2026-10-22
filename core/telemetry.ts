import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiCounters } from './types.js';

export type ApiEvent =
  { type: 'request'; method: string } | { type: 'retry' | 'limit'; message: string };
const context = new AsyncLocalStorage<{ emit: (event: ApiEvent) => void; paused: () => boolean }>();
export const withApiContext = <T>(
  emit: (event: ApiEvent) => void,
  paused: () => boolean,
  fn: () => Promise<T>,
) => context.run({ emit, paused }, fn);
export const apiEvent = (event: ApiEvent) => context.getStore()?.emit(event);
export class RequestPaused extends Error {}
export const checkRequestPause = () => {
  if (context.getStore()?.paused()) throw new RequestPaused();
};
export async function interruptibleWait(ms: number) {
  const until = Date.now() + ms;
  do {
    checkRequestPause();
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
  } while (true);
}
export const emptyCounters = (): ApiCounters => ({
  reads: 0,
  writes: 0,
  retries: 0,
  rateLimits: 0,
});
export function sumCounters(items: { api?: ApiCounters }[]): ApiCounters {
  return items.reduce((out, item) => {
    for (const key of Object.keys(out) as (keyof ApiCounters)[]) out[key] += item.api?.[key] || 0;
    return out;
  }, emptyCounters());
}
