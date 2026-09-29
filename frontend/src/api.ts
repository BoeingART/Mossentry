import type { Dashboard } from './types';

let csrf = '';
export function setCsrf(value: string) { csrf = value; }

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' || !csrf ? {} : { 'X-CSRF-Token': csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  }).catch(() => { throw new Error('Cannot reach the local service. Reopen the app and retry.'); });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = data?.detail;
    const labels: Record<string, string> = { name: 'server name', hostname: 'server address', port: 'SSH port', ssh_user: 'SSH login account', key_path: 'private key path', username: 'username', servers: 'server selection', public_port_start: 'start port', public_port_end: 'end port', new_password: 'new password' };
    const message = response.status === 500 ? 'The local service could not complete this operation. Please retry.'
      : Array.isArray(detail) ? [...new Set(detail.map(item => {
        if (item.type === 'value_error' && typeof item.msg === 'string') return item.msg.replace(/^Value error, /, '');
        const field = item.loc?.at(-1);
        return `Check the ${labels[field] || 'entered information'} and try again.`;
      }))].join(' ')
      : typeof detail === 'string' ? detail : 'The operation could not finish. Please retry.';
    const error = new Error(message) as Error & { status?: number };
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
    throw new Error(data?.detail || 'Credentials could not be downloaded');
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
