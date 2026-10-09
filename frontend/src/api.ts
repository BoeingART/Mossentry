import { t } from './i18n';
import type { Dashboard } from './types';

let csrf = '';
export function setCsrf(value: string) { csrf = value; }

export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' || !csrf ? {} : { 'X-CSRF-Token': csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
    signal,
  }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new Error(t("Cannot reach the local service. Reopen the app and retry."));
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = data?.detail;
    const labels: Record<string, string> = { name: t("server name"), hostname: t("server address"), port: t("SSH port"), ssh_user: t("SSH login account"), key_path: t("private key path"), username: t("username"), servers: t("server selection"), new_password: t("new password") };
    const message = response.status === 500 ? t("The local service could not complete this operation. Please retry.")
      : Array.isArray(detail) ? [...new Set(detail.map(item => {
        if (item.type === 'value_error' && typeof item.msg === 'string') return item.msg.replace(/^Value error, /, '');
        const field = item.loc?.at(-1);
        return t("Check the {0} and try again.", { 0: labels[field] || t("entered information") });
      }))].join(' ')
      : typeof detail === 'string' ? detail : t("The operation could not finish. Please retry.");
    const error = new Error(t(message)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export async function fetchDashboard() {
  const data = await api<Dashboard>('/api/dashboard');
  setCsrf(data.admin.csrf);
  return data;
}

export async function downloadCredentials(actionId: number, username: string) {
  const response = await fetch(`/api/actions/${actionId}/private-key`, { credentials: 'same-origin' });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || t("Credentials could not be downloaded"));
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${username}-server-login.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
