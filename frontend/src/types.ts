export type Server = {
  id: number; name: string; hostname: string; port: number; public_port_start: number | null;
  public_port_end: number | null; ssh_user: string; key_path: string; enabled: number; last_scan_at: string | null;
  last_scan_status: string | null; last_scan_error: string | null;
};
export type User = {
  id: number; username: string; server: string; full_name: string; uid: number;
  gid: number; home: string; shell: string; is_sudo: number; is_disabled: number;
  scanned_at: string;
};
export type Action = {
  id: number; action_type: 'create_user' | 'disable_user' | 'enable_user' | 'set_sudo' | 'delete_user';
  target_server: string; target_user: string; payload: { sudo?: boolean; servers?: string[]; full_name?: string };
  status: 'pending' | 'approved' | 'executed' | 'failed' | 'rejected';
  requested_at: string; approved_at: string | null; executed_at: string | null;
  error: string | null; key_fingerprint: string | null; private_key_ready: boolean;
  key_downloaded_at: string | null; requested_by_name: string; approved_by_name: string | null;
};
export type Audit = {
  id: number; event: string; target: string | null; details: Record<string, unknown>;
  ip_address: string | null; created_at: string; actor: string | null;
};
export type Dashboard = {
  admin: { username: string; csrf: string; desktop_mode: boolean };
  servers: Server[]; users: User[]; actions: Action[]; audit: Audit[];
};

export type ServerMetrics = {
  checked_at: string; uptime_seconds: number; load: number[]; memory_total_mb: number; memory_used_mb: number;
  disk_total_gb: number; disk_used_gb: number; disk_percent: number;
};
