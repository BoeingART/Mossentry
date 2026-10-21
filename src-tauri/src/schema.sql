
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL,
  ssh_user TEXT NOT NULL,
  key_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at TEXT,
  last_scan_status TEXT NOT NULL DEFAULT 'never',
  last_scan_error TEXT
);
CREATE TABLE IF NOT EXISTS server_users (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  uid INTEGER NOT NULL,
  gid INTEGER NOT NULL,
  home TEXT NOT NULL,
  shell TEXT NOT NULL,
  is_sudo INTEGER NOT NULL,
  is_disabled INTEGER NOT NULL,
  scanned_at TEXT NOT NULL,
  created_at TEXT,
  created_at_source TEXT,
  PRIMARY KEY (server_id, username)
);
CREATE TABLE IF NOT EXISTS server_credentials (
  server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  sudo_password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  username TEXT PRIMARY KEY,
  full_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES admins(id)
);
CREATE TABLE IF NOT EXISTS user_history (
  username TEXT PRIMARY KEY,
  dashboard_eligible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  created_at_source TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_batches (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  executed_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER REFERENCES approval_batches(id),
  action_type TEXT NOT NULL,
  target_server TEXT NOT NULL,
  target_user TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER NOT NULL REFERENCES admins(id),
  approved_by INTEGER REFERENCES admins(id),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  executed_at TEXT,
  error TEXT,
  public_key TEXT,
  key_fingerprint TEXT,
  private_key_path TEXT,
  key_downloaded_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES admins(id),
  event TEXT NOT NULL,
  target TEXT,
  details_json TEXT NOT NULL,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_server_users_username ON server_users(username);
CREATE INDEX IF NOT EXISTS idx_actions_status_requested ON actions(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE TABLE IF NOT EXISTS operation_jobs (
  id INTEGER PRIMARY KEY,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by INTEGER REFERENCES admins(id),
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS operation_results (
  job_id INTEGER NOT NULL REFERENCES operation_jobs(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY(job_id, server_name)
);
