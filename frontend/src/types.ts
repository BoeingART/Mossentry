export type Server = {
  id: number; name: string; hostname: string; port: number;
  ssh_user: string; key_path: string; enabled: number; last_scan_at: string | null;
  last_scan_status: string | null; last_scan_error: string | null;
  has_sudo_password: boolean | number; group_name: string; notes: string;
  ssh_backend: 'native' | 'openssh'; ssh_alias: string; ssh_options: string; ssh_jump_config: string;
};
export type User = {
  id: number; username: string; server: string; full_name: string; uid: number;
  gid: number; home: string; shell: string; is_sudo: number; is_disabled: number;
  scanned_at: string;
};
export type Action = {
  id: number; batch_id: number | null; action_type: 'create_user' | 'disable_user' | 'enable_user' | 'set_sudo' | 'delete_user';
  target_server: string; target_user: string; payload: { sudo?: boolean; servers?: string[]; full_name?: string };
  status: 'pending' | 'approved' | 'executed' | 'failed' | 'rejected';
  requested_at: string; approved_at: string | null; executed_at: string | null;
  error: string | null; key_fingerprint: string | null; private_key_ready: boolean;
  key_downloaded_at: string | null; requested_by_name: string; approved_by_name: string | null;
};
export type ApprovalBatch = {
  id: number; status: Action['status']; created_at: string;
  approved_at: string | null; executed_at: string | null; error: string | null;
};
export type Audit = {
  id: number; event: string; target: string | null; details: Record<string, unknown>;
  ip_address: string | null; created_at: string; actor: string | null;
};
export type Dashboard = {
  admin: { username: string; csrf: string; desktop_mode: boolean };
  servers: Server[]; users: User[]; actions: Action[]; approval_batches: ApprovalBatch[]; audit: Audit[];
  statistics: {
    total_unique_users: number; dated_users: number; undated_users: number; new_users_30d: number;
    new_accounts_30d: number; new_servers_30d: number; pending_approvals: number; new_pending_approvals_30d: number;
    history: { date: string; total: number; added: number }[]; through: string;
  };
};

export type ServerMetrics = {
  checked_at: string; uptime_seconds: number; load: number[]; memory_total_mb: number; memory_used_mb: number;
  disk_total_gb: number; disk_used_gb: number; disk_percent: number;
};

export type PhysicalDiskGroup = {
  id: string;
  devices: { name: string; model: string; total_gb: number; storage_type?: 'SSD' | 'HDD' | null }[];
  raid_levels?: string[];
  shared: boolean;
  total_gb: number;
  filesystem_total_gb: number | null;
  used_gb: number | null;
  percent: number | null;
  mounts: string[];
  status: 'ok' | 'unmounted' | 'unavailable';
};

export type ResourceMetrics = {
  checked_at: string;
  cpu: { percent: number; cores: number; users: { username: string; cpu_percent: number; processes: number }[] };
  memory: { total_mb: number; used_mb: number; percent: number };
  disks: PhysicalDiskGroup[];
  network?: {
    status: 'ok' | 'unavailable';
    interfaces: { name: string; rx_bytes_per_second: number | null; tx_bytes_per_second: number | null }[];
  };
  gpu: {
    status: 'ok' | 'unavailable' | 'error'; message: string;
    devices: {
      index: number; uuid: string; name: string; percent: number | null;
      memory_used_mb: number | null; memory_total_mb: number | null; temperature: number | null;
      process_memory_available: boolean; process_utilization_available: boolean;
      process_utilization_status?: 'ok' | 'no_activity' | 'unsupported' | 'unavailable' | 'error';
      processes: { pid: number; username: string | null; sm_percent: number | null; memory_mb: number | null;
        kind?: string; name?: string; sm_source?: 'pmon' | 'nvml' | 'no_activity' | 'unavailable' }[];
    }[];
  };
  warnings: string[];
};

export type FirewallStatus = { available: false } | {
  available: true; enabled: boolean; ssh_allowed: boolean; ssh_port: number | null; management_ip: string | null;
  revision: string; rules: { id: number; description: string }[];
};
export type PingResult = {
  ok: boolean; hostname: string; checked_at: string; exit_code: number | null; timed_out: boolean; output: string;
};
