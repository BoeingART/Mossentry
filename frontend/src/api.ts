import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import type { Dashboard } from './types';

// Retained for callers sharing the dashboard contract. IPC needs no HTTP CSRF token.
export function setCsrf(_value: string) {}
function requestError(cause: unknown) {
  const raw = cause as { status?: number; detail?: string };
  const error = new Error(t(raw?.detail || (cause instanceof Error ? cause.message : 'The operation could not finish. Please retry.'))) as Error & { status?: number };
  error.status = raw?.status;
  return error;
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const pending = invoke<T>('request', { path, method, body: body ?? null });
  if (!signal) return pending.catch(cause => { throw requestError(cause); });
  // Detach a hidden/unmounted monitor immediately. The Rust transport still drains
  // its bounded in-flight sample; abort never retries or cancels a remote mutation.
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => { if (!signal.aborted) resolve(value); }, cause => { if (!signal.aborted) reject(requestError(cause)); })
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function fetchDashboard() { return api<Dashboard>('/api/dashboard'); }
export async function downloadCredentials(actionId: number, _username: string) {
  try { return await invoke<boolean>('download_credentials', { actionId }); }
  catch (cause) { throw requestError(cause); }
}
