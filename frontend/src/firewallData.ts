import type { FirewallStatus, Server } from './types.ts';

export type FirewallEntry = { phase: 'checking' } | { phase: 'ready'; status: FirewallStatus } | { phase: 'error'; error: string };
export type FirewallRequest = (server: Server, body: Record<string, unknown>) => Promise<FirewallStatus>;

// A result belongs to these connection settings, not just a reusable server ID.
export function firewallSource(server: Server) {
  return JSON.stringify([server.id, server.name, server.hostname, server.port, server.ssh_user,
    server.key_path, server.ssh_backend, server.ssh_alias, server.ssh_options, server.ssh_jump_config,
    server.enabled, server.has_sudo_password]);
}

export function firewallState(server: Server, entry?: FirewallEntry) {
  if (!server.enabled) return 'paused';
  if (!entry) return 'waiting';
  if (entry.phase === 'checking') return 'checking';
  if (entry.phase === 'error') return 'error';
  if (!entry.status.available) return 'unavailable';
  return entry.status.enabled ? 'enabled' : 'disabled';
}

export class FirewallController {
  private entries: Record<string, FirewallEntry> = {};
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private checks = new Map<string, Promise<FirewallStatus>>();
  private transport: FirewallRequest;

  constructor(transport: FirewallRequest) { this.transport = transport; }
  snapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(source: string, entry: FirewallEntry) {
    this.entries = { ...this.entries, [source]: entry };
    this.listeners.forEach(listener => listener());
  }
  request(server: Server, body: Record<string, unknown>) {
    if (!server.enabled) return Promise.reject(new Error('Server management is paused.'));
    const source = firewallSource(server);
    // List checks and detail controls share the Rust operation lock. Drain an
    // in-flight check before starting the next request, including after navigation.
    const pending = this.tail.then(async () => {
      this.publish(source, { phase: 'checking' });
      try {
        const status = await this.transport(server, body);
        this.publish(source, { phase: 'ready', status });
        return status;
      } catch (cause) {
        this.publish(source, { phase: 'error', error: cause instanceof Error ? cause.message : 'Please retry the operation' });
        throw cause;
      }
    });
    this.tail = pending.then(() => {}, () => {});
    return pending;
  }
  check(server: Server) {
    const source = firewallSource(server);
    const existing = this.checks.get(source);
    if (existing) return existing;
    const pending = this.request(server, { operation: 'status' });
    this.checks.set(source, pending);
    void pending.then(() => { this.checks.delete(source); }, () => { this.checks.delete(source); });
    return pending;
  }
  async checkAll(servers: Server[], active: () => boolean) {
    for (const server of servers) {
      if (!active()) return;
      if (!server.enabled) continue;
      try { await this.check(server); }
      catch { /* Record each failure and continue checking the remaining servers. */ }
    }
  }
}
