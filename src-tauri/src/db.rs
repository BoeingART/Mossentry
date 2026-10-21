use crate::{
    config::{self, Config},
    error::Result,
};
use chrono::Utc;
use rusqlite::{params, types::ValueRef, Connection, Params};
use serde_json::{json, Map, Value};
use std::{fs::File, time::Duration};

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}
pub fn connect(config: &Config) -> Result<Connection> {
    let c = Connection::open(&config.db)?;
    c.busy_timeout(Duration::from_secs(15))?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
    Ok(c)
}
pub fn rows(c: &Connection, sql: &str, params: impl Params) -> Result<Vec<Value>> {
    let mut stmt = c.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = stmt
        .query_map(params, |row| {
            let mut value = Map::new();
            for (i, name) in names.iter().enumerate() {
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    ValueRef::Blob(_) => Value::Null,
                };
                value.insert(name.clone(), v);
            }
            Ok(Value::Object(value))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
pub fn row(c: &Connection, sql: &str, params: impl Params) -> Result<Option<Value>> {
    Ok(rows(c, sql, params)?.into_iter().next())
}
pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn n(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
pub fn audit(c: &Connection, event: &str, target: Option<&str>, details: Value) -> Result<()> {
    c.execute("INSERT INTO audit_log(actor_id,event,target,details_json,ip_address,created_at) VALUES((SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1),?,?,?,NULL,?)", params![event,target,details.to_string(),now()])?;
    Ok(())
}
pub fn init(config: &Config, seed: bool) -> Result<File> {
    config::private_dir(&config.home)?;
    config::private_dir(&config.data)?;
    config::private_dir(&config.data.join("keys"))?;
    config::private_dir(&config.data.join("jobs"))?;
    if let Some(parent) = config.db.parent().filter(|path| !path.exists()) {
        config::private_dir(parent)?;
    }
    let lock = config::private_file(&config.db.with_extension("lock"), false)?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| {
        crate::error::Error::new(
            409,
            "This data directory is already open in another Mossentry instance",
        )
    })?;
    config::private_file(&config.db, false)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = std::path::PathBuf::from(format!("{}{suffix}", config.db.display()));
        if sidecar.exists() {
            config::permissions(&sidecar, 0o600)?;
        }
    }
    let mut c = connect(config)?;
    let tx = c.transaction()?;
    tx.execute_batch(include_str!("schema.sql"))?;
    for (table, col, definition) in [
        ("servers", "group_name", "TEXT NOT NULL DEFAULT ''"),
        ("servers", "notes", "TEXT NOT NULL DEFAULT ''"),
        ("server_users", "created_at", "TEXT"),
        ("server_users", "created_at_source", "TEXT"),
        (
            "user_history",
            "dashboard_eligible",
            "INTEGER NOT NULL DEFAULT 1",
        ),
    ] {
        let columns = rows(&tx, &format!("PRAGMA table_info({table})"), [])?;
        if !columns.iter().any(|v| s(v, "name") == col) {
            tx.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {col} {definition}"
            ))?;
        }
    }
    if seed
        && row(&tx, "SELECT 1 FROM settings WHERE key='servers_seeded'", [])?.is_none()
        && row(&tx, "SELECT 1 FROM servers LIMIT 1", [])?.is_none()
    {
        let ssh = config::setting("SSH_DIR")
            .map(|p| config::expand_path(&p))
            .unwrap_or_else(|| config::expand_path("~/.ssh"));
        for (name, port) in [
            ("gpu1", 10901),
            ("gpu2", 11901),
            ("gpu3", 12901),
            ("gpu4", 13901),
            ("cpu1", 20901),
        ] {
            tx.execute("INSERT INTO servers(name,hostname,port,ssh_user,key_path) VALUES(?,'server.luo-group.com',?,'srvmgr',?)",params![name,port,ssh.join("id_rsa").to_string_lossy()])?;
        }
    }
    tx.execute(
        "INSERT OR IGNORE INTO settings(key,value) VALUES('servers_seeded','1')",
        [],
    )?;
    if row(&tx, "SELECT 1 FROM admins LIMIT 1", [])?.is_none() {
        tx.execute("INSERT INTO admins(username,password_hash,created_at) VALUES(?,'!rust-desktop-only',?)",params![config::setting("ADMIN_USER").unwrap_or_else(||"admin".into()),now()])?;
    }
    crate::history::remember(&tx)?;
    tx.execute("UPDATE operation_results SET status='interrupted',error=?,finished_at=? WHERE status IN ('queued','running')",params![crate::operations::INTERRUPTED,now()])?;
    tx.execute(
        "UPDATE operation_jobs SET status='interrupted',finished_at=? WHERE status='running'",
        params![now()],
    )?;
    tx.execute(
        "UPDATE actions SET status='failed',error=?,executed_at=? WHERE status='approved'",
        params![crate::operations::INTERRUPTED, now()],
    )?;
    crate::operations::backfill(&tx)?;
    tx.commit()?;
    let initial = config.data.join("initial_admin_password");
    if initial.exists() {
        std::fs::remove_file(initial)?;
    }
    Ok(lock)
}
