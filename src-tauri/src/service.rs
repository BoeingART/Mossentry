use crate::{
    config::{self, Config},
    db::{self, n, s},
    error::{friendly, Error, Result},
    history,
    model::{self, Operation, ServerInput},
    operations,
    ssh::{self, Transport},
    ssh_config,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub struct OperationGuard(Arc<AtomicBool>);
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
#[derive(Default)]
struct Samples {
    inflight: HashSet<String>,
    cache: HashMap<String, (Instant, Value)>,
}
pub struct Service {
    pub config: Config,
    pub transport: Arc<dyn Transport>,
    busy: Arc<AtomicBool>,
    samples: Mutex<Samples>,
    preferences: Mutex<()>,
    _data_lock: File,
}
impl Service {
    pub fn open(config: Config, transport: Arc<dyn Transport>) -> Result<Arc<Self>> {
        let lock = db::init(&config)?;
        Ok(Arc::new(Self {
            config,
            transport,
            busy: Arc::new(AtomicBool::new(false)),
            samples: Mutex::new(Samples::default()),
            preferences: Mutex::new(()),
            _data_lock: lock,
        }))
    }
    pub fn connection(&self) -> Result<Connection> {
        db::connect(&self.config)
    }
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }
    pub fn acquire(&self) -> Result<OperationGuard> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                Error::new(
                    409,
                    "Another server operation is running. Wait for it to finish and retry",
                )
            })?;
        Ok(OperationGuard(self.busy.clone()))
    }
    pub fn server(&self, id: i64) -> Result<Value> {
        db::row(
            &self.connection()?,
            "SELECT * FROM servers WHERE id=?",
            [id],
        )?
        .ok_or_else(|| Error::new(404, "Server no longer exists. Refresh the list"))
    }
    pub fn server_by_name(&self, name: &str) -> Result<Value> {
        db::row(
            &self.connection()?,
            "SELECT * FROM servers WHERE name=?",
            [name],
        )?
        .ok_or_else(|| Error::new(404, "Server no longer exists. Refresh the list"))
    }
    pub fn validate_servers(&self, names: &[String]) -> Result<Vec<String>> {
        let unique = model::server_names(&json!(names))?;
        let c = self.connection()?;
        for name in &unique {
            if db::row(
                &c,
                "SELECT 1 FROM servers WHERE name=? AND enabled=1",
                [name],
            )?
            .is_none()
            {
                return Err(Error::bad(
                    "The selection includes an unknown or disabled host",
                ));
            }
        }
        Ok(unique)
    }
    pub fn protect(&self, username: &str, names: &[String]) -> Result<()> {
        model::username(username)?;
        if ["srvmgr", "sync"].contains(&username) {
            return Ok(());
        }
        let c = self.connection()?;
        for name in names {
            let server = self.server_by_name(name)?;
            let account = db::row(
                &c,
                "SELECT uid FROM server_users WHERE server_id=? AND username=?",
                params![n(&server, "id"), username],
            )?;
            if ["root", "nobody", s(&server, "ssh_user")].contains(&username)
                || account.is_some_and(|a| n(&a, "uid") < 1000)
            {
                return Err(Error::bad(
                    "System and SSH management accounts are protected",
                ));
            }
        }
        Ok(())
    }
    pub fn password(&self, server: &Value) -> Result<Option<String>> {
        if let Some(c) = db::row(
            &self.connection()?,
            "SELECT sudo_password FROM server_credentials WHERE server_id=?",
            [n(server, "id")],
        )? {
            return Ok(Some(s(&c, "sudo_password").into()));
        }
        let path = config::setting("BECOME_PASSWORD_FILE")
            .map(|p| config::expand_path(&p))
            .unwrap_or_else(|| self.config.data.join("srvmgr.passwd"));
        if !path.exists() {
            return Ok(None);
        }
        config::check_private(&path, "sudo password file").map_err(Error::bad)?;
        let text = std::fs::read_to_string(path)?;
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() || text.contains(['\r', '\n', '\0']) {
            return Err(Error::bad(
                "The sudo password file must contain exactly one nonempty line",
            ));
        }
        Ok(Some(text.into()))
    }
    pub fn remote(
        &self,
        server: &Value,
        source: &str,
        payload: &Value,
        sudo: bool,
        timeout: u64,
    ) -> std::result::Result<Value, String> {
        let password = if sudo {
            self.password(server).map_err(|e| e.detail)?
        } else {
            None
        };
        self.transport
            .execute(server, source, payload, sudo, password.as_deref(), timeout)
            .map_err(|e| ssh::redact(&e, password.as_deref()))
    }
    pub fn request(self: &Arc<Self>, path: &str, method: &str, body: Value) -> Result<Value> {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        // Desktop IPC is local to the main webview; no HTTP listener or browser session.
        match (method, parts.as_slice()) {
            ("GET", ["health"]) => Ok(json!({"status":"ok"})),
            ("GET", ["api", "dashboard"]) => self.dashboard(),
            ("POST", ["api", "servers"]) => {
                let _g = self.acquire()?;
                self.create_server(ServerInput::parse(body)?)
            }
            ("PUT", ["api", "servers", id]) => {
                let _g = self.acquire()?;
                self.update_server(id_number(id)?, ServerInput::parse(body)?)
            }
            ("DELETE", ["api", "servers", id]) => {
                let _g = self.acquire()?;
                self.delete_server(id_number(id)?)
            }
            ("POST", ["api", "servers", id, operation]) => {
                let server = self.server(id_number(id)?)?;
                self.validate_servers(&[s(&server, "name").into()])?;
                if *operation == "metrics" {
                    return self.metrics(&server);
                }
                let _g = self.acquire()?;
                match *operation {
                    "test" => self.test_connection(&server),
                    "status" => self.status(&server),
                    "scan" => self.scan(&[s(&server, "name").into()]),
                    _ => Err(Error::new(404, "Unknown operation")),
                }
            }
            ("POST", ["api", "scan"]) => {
                let _g = self.acquire()?;
                let names: Vec<String> = db::rows(
                    &self.connection()?,
                    "SELECT name FROM servers WHERE enabled=1 ORDER BY name",
                    [],
                )?
                .iter()
                .map(|s| db::s(s, "name").into())
                .collect();
                if names.is_empty() {
                    return Err(Error::bad("Add or enable a server before syncing"));
                }
                self.scan(&names)
            }
            ("POST", ["api", "approval-batches", id, operation]) => {
                let _g = self.acquire()?;
                match *operation {
                    "approve" => self.approve_batch(id_number(id)?),
                    "reject" => self.reject_batch(id_number(id)?),
                    _ => Err(Error::new(404, "Unknown operation")),
                }
            }
            ("DELETE", ["api", "approval-batches", batch, "items", item]) => {
                let _g = self.acquire()?;
                self.remove_batch_item(id_number(batch)?, id_number(item)?)
            }
            ("POST", ["api", "actions", "create-user"]) => {
                let _g = self.acquire()?;
                self.queue_action(&body, true)
            }
            ("POST", ["api", "actions", "user"]) => {
                let _g = self.acquire()?;
                self.queue_action(&body, false)
            }
            ("POST", ["api", "actions", id, "approve"]) => {
                let _g = self.acquire()?;
                self.approve(id_number(id)?)
            }
            ("POST", ["api", "actions", id, "reject"]) => {
                let _g = self.acquire()?;
                self.reject(id_number(id)?)
            }
            ("PUT", ["api", "users", username, "profile"]) => self.profile(username, &body),
            ("GET", ["api", "ssh-config"]) => Ok(
                json!({"path":ssh_config::default_path(),"exists":ssh_config::default_path().is_file()}),
            ),
            ("POST", ["api", "inventory", "import"]) => {
                let _g = self.acquire()?;
                self.import_inventory(body)
            }
            ("POST", ["api", "operations", "review"]) => {
                let b = Operation::parse(body)?;
                self.validate_servers(&b.servers)?;
                if b.operation != "command" || b.command.trim().is_empty() {
                    return Err(Error::bad("Enter a Linux command (up to 32768 characters)"));
                }
                Ok(json!({"warnings":operations::risks(&b.command,b.elevated)}))
            }
            ("POST", ["api", "operations"]) => {
                let guard = self.acquire()?;
                operations::start(self.clone(), Operation::parse(body)?, guard)
            }
            ("GET", ["api", "operations"]) => {
                let offset = query
                    .split('&')
                    .find_map(|q| q.strip_prefix("offset="))
                    .unwrap_or("0")
                    .parse::<i64>()
                    .map_err(|_| Error::bad("Invalid history offset"))?;
                if offset < 0 {
                    return Err(Error::bad("Invalid history offset"));
                }
                let c = self.connection()?;
                Ok(
                    json!({"jobs":db::rows(&c,"SELECT id,operation,status,created_at,finished_at FROM operation_jobs ORDER BY id DESC LIMIT 25 OFFSET ?",[offset])?,"total":db::row(&c,"SELECT COUNT(*) AS count FROM operation_jobs",[])?.unwrap()["count"]}),
                )
            }
            ("GET", ["api", "operations", id]) => {
                operations::detail(&self.connection()?, id_number(id)?)
            }
            ("DELETE", ["api", "operations", id]) => {
                let _g = self.acquire()?;
                let id = id_number(id)?;
                let c = self.connection()?;
                let job = db::row(&c, "SELECT status FROM operation_jobs WHERE id=?", [id])?
                    .ok_or_else(|| Error::new(404, "Operation no longer exists"))?;
                if s(&job, "status") == "running" {
                    return Err(Error::new(409, "Wait for the operation to finish"));
                }
                c.execute("DELETE FROM operation_jobs WHERE id=?", [id])?;
                db::audit(
                    &c,
                    "operation_deleted",
                    Some(&format!("job:{id}")),
                    json!({}),
                )?;
                Ok(json!({"ok":true}))
            }
            _ => Err(Error::new(404, "Unknown operation")),
        }
    }
    fn dashboard(&self) -> Result<Value> {
        let c = self.connection()?;
        let mut servers=db::rows(&c,"SELECT s.*,EXISTS(SELECT 1 FROM server_credentials WHERE server_id=s.id) AS has_sudo_password FROM servers s ORDER BY name",[])?;
        for server in &mut servers {
            if let Some(raw) = server["last_scan_error"].as_str() {
                server["last_scan_error"] = json!(friendly(raw));
            }
        }
        let users=db::rows(&c,"SELECT su.server_id,su.username,su.uid,su.gid,su.home,su.shell,su.is_sudo,su.is_disabled,su.scanned_at,s.name AS server,COALESCE(up.full_name,'') AS full_name FROM server_users su JOIN servers s ON s.id=su.server_id LEFT JOIN user_profiles up ON up.username=su.username ORDER BY su.username,s.name",[])?;
        let mut actions=db::rows(&c,"SELECT ac.id,ac.batch_id,ac.action_type,ac.target_server,ac.target_user,ac.payload_json,ac.status,ac.requested_at,ac.approved_at,ac.executed_at,ac.error,ac.key_fingerprint,ac.private_key_path,ac.key_downloaded_at,req.username AS requested_by_name,app.username AS approved_by_name FROM actions ac JOIN admins req ON req.id=ac.requested_by LEFT JOIN admins app ON app.id=ac.approved_by WHERE ac.batch_id IN (SELECT id FROM approval_batches ORDER BY id DESC LIMIT 100) OR ac.batch_id IS NULL AND ac.id IN (SELECT id FROM actions ORDER BY id DESC LIMIT 100) ORDER BY ac.id DESC",[])?;
        for a in &mut actions {
            a["payload"] = serde_json::from_str(s(a, "payload_json"))?;
            a["private_key_ready"] =
                json!(!s(a, "private_key_path").is_empty() && a["key_downloaded_at"].is_null());
            a.as_object_mut().unwrap().remove("payload_json");
            a.as_object_mut().unwrap().remove("private_key_path");
            if let Some(raw) = a["error"].as_str() {
                a["error"] = json!(friendly(raw));
            }
        }
        let mut logs=db::rows(&c,"SELECT al.id,al.event,al.target,al.ip_address,al.created_at,a.username AS actor FROM audit_log al LEFT JOIN admins a ON a.id=al.actor_id ORDER BY al.id DESC LIMIT 100",[])?;
        for log in &mut logs {
            log["details"] = json!({});
        }
        let admin = db::row(
            &c,
            "SELECT username FROM admins WHERE active=1 ORDER BY id LIMIT 1",
            [],
        )?
        .ok_or_else(|| Error::new(500, "No administrator account is available"))?;
        Ok(
            json!({"admin":{"username":admin["username"],"csrf":"","desktop_mode":true},"servers":servers,"users":users,"actions":actions,"approval_batches":db::rows(&c,"SELECT * FROM approval_batches ORDER BY id DESC LIMIT 100",[])?,"audit":logs,"statistics":history::statistics(&c)?}),
        )
    }
    fn no_pending(&self, server: &Value) -> Result<()> {
        for action in db::rows(
            &self.connection()?,
            "SELECT payload_json FROM actions WHERE status IN ('pending','approved')",
            [],
        )? {
            let p: Value = serde_json::from_str(s(&action, "payload_json"))?;
            if p["servers"]
                .as_array()
                .is_some_and(|a| a.contains(&server["name"]))
            {
                return Err(Error::new(
                    409,
                    "Handle this server's pending requests before changing or removing it",
                ));
            }
        }
        Ok(())
    }
    fn save_password(c: &Connection, id: i64, b: &ServerInput, changed: bool) -> Result<()> {
        if b.clear_sudo_password || changed {
            c.execute("DELETE FROM server_credentials WHERE server_id=?", [id])?;
        }
        if let Some(password) = b
            .sudo_password
            .as_deref()
            .filter(|s| !s.is_empty() && !b.clear_sudo_password)
        {
            c.execute(
                "INSERT OR REPLACE INTO server_credentials(server_id,sudo_password) VALUES(?,?)",
                params![id, password],
            )?;
        }
        Ok(())
    }
    fn insert_server(c: &Connection, b: &ServerInput, enabled: bool) -> Result<i64> {
        c.execute("INSERT INTO servers(name,hostname,port,ssh_user,key_path,enabled,group_name,notes,ssh_backend,ssh_alias,ssh_options,ssh_jump_config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![b.name,b.hostname,b.port,b.ssh_user,b.key_path,enabled,b.group_name,b.notes,b.ssh_backend,b.ssh_alias,b.ssh_options,b.ssh_jump_config])?;
        Ok(c.last_insert_rowid())
    }
    fn create_server(&self, b: ServerInput) -> Result<Value> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let id = Self::insert_server(&tx, &b, b.enabled)?;
        Self::save_password(&tx, id, &b, false)?;
        db::audit(&tx, "server_created", Some(&b.name), json!({}))?;
        tx.commit()?;
        Ok(json!({"ok":true,"id":id}))
    }
    fn update_server(&self, id: i64, b: ServerInput) -> Result<Value> {
        let old = self.server(id)?;
        self.no_pending(&old)?;
        let identity = s(&old, "hostname") != b.hostname
            || n(&old, "port") != b.port as i64
            || s(&old, "ssh_user") != b.ssh_user;
        let routing_changed = s(&old, "ssh_backend") != b.ssh_backend
            || s(&old, "ssh_alias") != b.ssh_alias
            || s(&old, "ssh_options") != b.ssh_options
            || s(&old, "ssh_jump_config") != b.ssh_jump_config;
        let changed = identity || routing_changed || s(&old, "key_path") != b.key_path;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        tx.execute("UPDATE servers SET name=?,hostname=?,port=?,ssh_user=?,key_path=?,enabled=?,group_name=?,notes=?,ssh_backend=?,ssh_alias=?,ssh_options=?,ssh_jump_config=? WHERE id=?",params![b.name,b.hostname,b.port,b.ssh_user,b.key_path,b.enabled,b.group_name,b.notes,b.ssh_backend,b.ssh_alias,b.ssh_options,b.ssh_jump_config,id])?;
        Self::save_password(&tx, id, &b, identity || routing_changed)?;
        if changed {
            tx.execute("DELETE FROM server_users WHERE server_id=?", [id])?;
            tx.execute("UPDATE servers SET last_scan_at=NULL,last_scan_status='never',last_scan_error=NULL WHERE id=?",[id])?;
        }
        db::audit(
            &tx,
            "server_updated",
            Some(&b.name),
            json!({"previous_name":old["name"]}),
        )?;
        tx.commit()?;
        Ok(json!({"ok":true}))
    }
    fn delete_server(&self, id: i64) -> Result<Value> {
        let server = self.server(id)?;
        self.no_pending(&server)?;
        let c = self.connection()?;
        c.execute("DELETE FROM servers WHERE id=?", [id])?;
        db::audit(&c, "server_removed", Some(s(&server, "name")), json!({}))?;
        Ok(json!({"ok":true}))
    }
    fn import_inventory(&self, body: Value) -> Result<Value> {
        if body.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| !["path", "preview", "revision", "names"].contains(&k.as_str()))
        }) {
            return Err(Error::bad("Invalid SSH config import"));
        }
        let path = body
            .get("path")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(config::expand_path)
            .unwrap_or_else(ssh_config::default_path);
        let imported = ssh_config::SshConfig::load(&path)?.import()?;
        let mut c = self.connection()?;
        let mut conflicts = Vec::new();
        for server in &imported.servers {
            if db::row(&c, "SELECT 1 FROM servers WHERE name=?", [&server.name])?.is_some() {
                conflicts.push(server.name.clone());
            }
        }
        if body.get("preview").is_none_or(|v| *v == true) {
            return Ok(
                json!({"servers":imported.servers,"conflicts":conflicts,"warnings":imported.warnings,"revision":imported.revision}),
            );
        }
        if body["preview"] != false {
            return Err(Error::bad("Invalid SSH config import"));
        }
        if body["revision"].as_str() != Some(imported.revision.as_str()) {
            return Err(Error::new(
                409,
                "SSH config changed. Preview it again before importing.",
            ));
        }
        let names: Vec<String> = serde_json::from_value(body["names"].clone())
            .map_err(|_| Error::bad("Select hosts to import"))?;
        if names.is_empty()
            || names.iter().collect::<HashSet<_>>().len() != names.len()
            || names
                .iter()
                .any(|name| !imported.servers.iter().any(|server| &server.name == name))
        {
            return Err(Error::bad("Select hosts to import"));
        }
        if conflicts.iter().any(|name| names.contains(name)) {
            return Err(Error::new(409, "Some selected server names already exist"));
        }
        let tx = c.transaction()?;
        for server in imported.servers.iter().filter(|s| names.contains(&s.name)) {
            Self::insert_server(&tx, server, false)?;
        }
        db::audit(
            &tx,
            "inventory_imported",
            None,
            json!({"count":names.len(),"source":"ssh_config"}),
        )?;
        tx.commit()?;
        Ok(json!({"ok":true,"count":names.len()}))
    }
    fn profile(&self, username: &str, body: &Value) -> Result<Value> {
        model::username(username)?;
        let name = body["full_name"].as_str().unwrap_or("").trim();
        if name.chars().count() > 100 {
            return Err(Error::bad("Check the entered information and try again."));
        }
        let c = self.connection()?;
        if db::row(
            &c,
            "SELECT 1 FROM server_users WHERE username=? LIMIT 1",
            [username],
        )?
        .is_none()
        {
            return Err(Error::new(404, "User not found. Sync hosts first"));
        }
        self.save_profile(&c, username, name)?;
        db::audit(
            &c,
            "user_profile_updated",
            Some(username),
            json!({"full_name":name}),
        )?;
        Ok(json!({"ok":true,"full_name":name,"message":"Name or note updated"}))
    }
    pub fn save_profile(&self, c: &Connection, username: &str, name: &str) -> Result<()> {
        if name.is_empty() {
            c.execute("DELETE FROM user_profiles WHERE username=?", [username])?;
        } else {
            c.execute("INSERT INTO user_profiles(username,full_name,updated_at,updated_by) VALUES(?,?,?,(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1)) ON CONFLICT(username) DO UPDATE SET full_name=excluded.full_name,updated_at=excluded.updated_at,updated_by=excluded.updated_by",params![username,name,db::now()])?;
        }
        Ok(())
    }
    fn test_connection(&self, server: &Value) -> Result<Value> {
        let result = self.remote(
            server,
            ssh::ACCOUNTS,
            &json!({"operation":"test_connection"}),
            false,
            30,
        );
        let ok = result.is_ok();
        let message = result.err().unwrap_or_default();
        db::audit(
            &self.connection()?,
            if ok {
                "connection_tested"
            } else {
                "connection_failed"
            },
            Some(s(server, "name")),
            json!({"ok":ok,"output":message}),
        )?;
        Ok(
            json!({"ok":ok,"message":if ok{"SSH connection successful".into()}else{friendly(&message)}}),
        )
    }
    fn status(&self, server: &Value) -> Result<Value> {
        let result = self.remote(
            server,
            ssh::ACCOUNTS,
            &json!({"operation":"server_status"}),
            false,
            45,
        );
        match result {
            Ok(raw) => {
                let memory: HashMap<&str, f64> = s(&raw, "memory")
                    .lines()
                    .filter_map(|line| {
                        let (k, v) = line.split_once(':')?;
                        Some((k, v.split_whitespace().next()?.parse().ok()?))
                    })
                    .collect();
                let disk: Vec<&str> = s(&raw, "disk")
                    .lines()
                    .last()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect();
                let parse = |v: Option<&str>| {
                    v.unwrap_or("")
                        .parse::<f64>()
                        .map_err(|_| Error::remote("Invalid status response"))
                };
                let total = *memory
                    .get("MemTotal")
                    .ok_or_else(|| Error::remote("Invalid status response"))?;
                let available = *memory
                    .get("MemAvailable")
                    .ok_or_else(|| Error::remote("Invalid status response"))?;
                let load: Vec<f64> = s(&raw, "load")
                    .split_whitespace()
                    .take(3)
                    .map(|v| parse(Some(v)))
                    .collect::<Result<_>>()?;
                let result = json!({"checked_at":db::now(),"uptime_seconds":parse(s(&raw,"uptime").split_whitespace().next())? as u64,"load":load,"memory_total_mb":(total/1024.).round(),"memory_used_mb":((total-available)/1024.).round(),"disk_total_gb":(parse(disk.get(1).copied())?/1048576.*10.).round()/10.,"disk_used_gb":(parse(disk.get(2).copied())?/1048576.*10.).round()/10.,"disk_percent":parse(disk.get(4).map(|v|v.trim_end_matches('%')))?});
                db::audit(
                    &self.connection()?,
                    "status_checked",
                    Some(s(server, "name")),
                    json!({}),
                )?;
                Ok(result)
            }
            Err(raw) => {
                db::audit(
                    &self.connection()?,
                    "status_failed",
                    Some(s(server, "name")),
                    json!({"error":raw}),
                )?;
                Err(Error::remote(raw))
            }
        }
    }
    fn metrics(&self, server: &Value) -> Result<Value> {
        let identity = json!([
            server["id"],
            server["hostname"],
            server["port"],
            server["ssh_user"],
            server["key_path"],
            server["ssh_backend"],
            server["ssh_alias"],
            server["ssh_options"],
            server["ssh_jump_config"]
        ])
        .to_string();
        {
            let mut samples = self
                .samples
                .lock()
                .map_err(|_| Error::new(500, "Resource monitor unavailable"))?;
            if let Some((time, value)) = samples
                .cache
                .get(&identity)
                .filter(|(time, _)| time.elapsed() < Duration::from_secs(3))
            {
                let _ = time;
                return Ok(value.clone());
            }
            if !samples.inflight.insert(identity.clone()) {
                return Err(Error::new(
                    409,
                    "A resource sample is already running. Retrying shortly.",
                ));
            }
        }
        let result = self
            .remote(server, ssh::RESOURCES, &json!({}), false, 30)
            .map_err(Error::remote)
            .and_then(|v| {
                if ["checked_at", "cpu", "memory", "disks", "gpu", "warnings"]
                    .iter()
                    .all(|k| v.get(k).is_some())
                {
                    Ok(v)
                } else {
                    Err(Error::remote("Invalid resource sample"))
                }
            });
        let mut samples = self
            .samples
            .lock()
            .map_err(|_| Error::new(500, "Resource monitor unavailable"))?;
        samples.inflight.remove(&identity);
        if let Ok(value) = &result {
            if samples.cache.len() >= 64 {
                if let Some(key) = samples
                    .cache
                    .iter()
                    .min_by_key(|(_, v)| v.0)
                    .map(|(k, _)| k.clone())
                {
                    samples.cache.remove(&key);
                }
            }
            samples
                .cache
                .insert(identity, (Instant::now(), value.clone()));
        }
        result
    }
    pub fn scan(&self, names: &[String]) -> Result<Value> {
        let mut errors = serde_json::Map::new();
        let mut count = 0;
        for name in names {
            let server = self.server_by_name(name)?;
            let result=self.remote(&server,ssh::ACCOUNTS,&json!({"operation":"scan_users","ssh_user":server["ssh_user"],"creation_source":ssh::CREATION}),true,120);
            let result = result.and_then(|raw| {
                if raw["passwd"].is_string() {
                    Ok(raw)
                } else {
                    Err("Invalid account scan".into())
                }
            });
            match result {
                Ok(raw) => {
                    count += self.store_scan(&server, &raw)?;
                }
                Err(raw) => {
                    self.connection()?.execute("UPDATE servers SET last_scan_at=?,last_scan_status='error',last_scan_error=? WHERE id=?",params![db::now(),raw,n(&server,"id")])?;
                    errors.insert(name.clone(), json!(friendly(&raw)));
                }
            }
        }
        db::audit(
            &self.connection()?,
            if errors.is_empty() {
                "scan_completed"
            } else {
                "scan_failed"
            },
            Some(&names.join(",")),
            json!({"users":count,"errors":errors}),
        )?;
        Ok(json!({"ok":errors.is_empty(),"users":count,"errors":errors}))
    }
    fn store_scan(&self, server: &Value, raw: &Value) -> Result<usize> {
        if !raw["passwd"].is_string() {
            return Err(Error::remote("Invalid account scan"));
        }
        let mut sudo: HashSet<&str> = s(raw, "effective_sudo").lines().collect();
        for group in ["sudo", "wheel"] {
            if let Some(members) = s(raw, group).trim().split(':').nth(3) {
                sudo.extend(members.split(','));
            }
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let id = n(server, "id");
        let now = db::now();
        let mut count = 0;
        let previous = db::rows(&tx, "SELECT * FROM server_users WHERE server_id=?", [id])?;
        tx.execute("DELETE FROM server_users WHERE server_id=?", [id])?;
        for line in s(raw, "passwd").lines() {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() != 7 {
                continue;
            }
            let (Ok(uid), Ok(gid)) = (fields[2].parse::<i64>(), fields[3].parse::<i64>()) else {
                continue;
            };
            let name = fields[0];
            let home = fields[5];
            let shell = fields[6];
            let created = &raw["creation_times"][name];
            let (mut date, mut source) =
                (created["created_at"].as_str(), created["source"].as_str());
            if let Some(old) = previous
                .iter()
                .find(|v| s(v, "username") == name && n(v, "uid") == uid && s(v, "home") == home)
            {
                if date.is_none()
                    || source == Some("home_birth")
                        && ["auth_log", "journal"].contains(&s(old, "created_at_source"))
                {
                    date = old["created_at"].as_str();
                    source = old["created_at_source"].as_str();
                }
            }
            tx.execute("INSERT INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,scanned_at,created_at,created_at_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![id,name,uid,gid,home,shell,sudo.contains(name)||name=="root",shell.ends_with("/nologin")||shell.ends_with("/false"),now,date,source])?;
            count += 1;
        }
        tx.execute("UPDATE servers SET last_scan_at=?,last_scan_status='ok',last_scan_error=NULL WHERE id=?",params![now,id])?;
        history::remember(&tx)?;
        tx.commit()?;
        Ok(count)
    }
    pub fn appearance(&self) -> Result<Value> {
        let path = self.config.home.join("appearance.json");
        let saved = db::row(
            &self.connection()?,
            "SELECT value FROM settings WHERE key='rust_appearance'",
            [],
        )?;
        let value: Value = if let Some(saved) = saved {
            serde_json::from_str(s(&saved, "value"))?
        } else {
            match std::fs::read(path) {
                Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(json!({})),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
                Err(e) => return Err(e.into()),
            }
        };
        let mut result = json!({});
        for key in ["language", "colorScheme"] {
            if valid_preference(key, s(&value, key)) {
                result[key] = value[key].clone();
            }
        }
        Ok(result)
    }
    pub fn set_preference(&self, key: &str, value: &str) -> Result<()> {
        if !valid_preference(key, value) {
            return Err(Error::bad("Invalid appearance preference"));
        }
        let _lock = self
            .preferences
            .lock()
            .map_err(|_| Error::new(500, "Could not save appearance preference"))?;
        let mut preferences = self.appearance()?;
        preferences[key] = json!(value);
        let c = self.connection()?;
        // SQLite supplies atomic replacement on every supported OS; mirror the legacy
        // file for migration and keep the database authoritative after the first write.
        c.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('rust_appearance',?)",
            [preferences.to_string()],
        )?;
        let path = self.config.home.join("appearance.json");
        use std::io::Write;
        let mut file = config::private_file(&path, false)?;
        file.set_len(0)?;
        file.write_all(preferences.to_string().as_bytes())?;
        file.sync_all()?;
        Ok(())
    }
}
fn valid_preference(key: &str, value: &str) -> bool {
    match key {
        "language" => ["en", "zh"].contains(&value),
        "colorScheme" => ["light", "dark", "auto"].contains(&value),
        _ => false,
    }
}
fn id_number(s: &str) -> Result<i64> {
    s.parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::bad("Invalid identifier"))
}
