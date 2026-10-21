use crate::{
    config,
    db::{self, n, s},
    error::{Error, Result},
    model,
    service::Service,
    ssh,
};
use rand::{distributions::Alphanumeric, seq::SliceRandom, Rng};
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

impl Service {
    pub fn queue_action(&self, body: &Value, creating: bool) -> Result<Value> {
        let username = body["username"]
            .as_str()
            .ok_or_else(|| Error::bad("Invalid username"))?;
        let names = self.validate_servers(&model::server_names(&body["servers"])?)?;
        self.protect(username, &names)?;
        let action = if creating {
            "create_user"
        } else {
            s(body, "action")
        };
        if (!creating && action == "create_user")
            || ![
                "create_user",
                "disable_user",
                "enable_user",
                "set_sudo",
                "delete_user",
            ]
            .contains(&action)
        {
            return Err(Error::bad("Unknown action type"));
        }
        let mut payload = json!({"servers":names});
        if action == "set_sudo" || creating {
            let sudo = if creating && body.get("sudo").is_none() {
                false
            } else {
                body["sudo"]
                    .as_bool()
                    .ok_or_else(|| Error::bad("Specify the desired sudo access"))?
            };
            payload["sudo"] = json!(sudo);
        }
        if creating {
            payload["full_name"] = json!(s(body, "full_name")
                .trim()
                .chars()
                .take(100)
                .collect::<String>());
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let batch = crate::batches::pending(&tx)?;
        if let Some(existing) = db::row(&tx, "SELECT id FROM actions WHERE batch_id=? AND status='pending' AND action_type=? AND target_user=? AND payload_json=?", params![batch, action, username, payload.to_string()])? {
            return Ok(json!({"ok":true,"action_id":existing["id"],"batch_id":batch}));
        }
        if n(
            &db::row(
                &tx,
                "SELECT COUNT(*) AS count FROM actions WHERE batch_id=?",
                [batch],
            )?
            .unwrap(),
            "count",
        ) >= 200
        {
            return Err(Error::bad(
                "Approve the current list before adding more operations",
            ));
        }
        tx.execute("INSERT INTO actions(batch_id,action_type,target_server,target_user,payload_json,status,requested_by,requested_at) VALUES(?,?,?,?,?,'pending',(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1),?)",params![batch,action,names.join(","),username,payload.to_string(),db::now()])?;
        let id = tx.last_insert_rowid();
        db::audit(
            &tx,
            "action_requested",
            Some(&format!("action:{id}")),
            json!({"type":action,"username":username,"servers":names}),
        )?;
        tx.commit()?;
        Ok(
            json!({"ok":true,"action_id":id,"batch_id":batch,"message":if creating{"The creation request is pending approval"}else{"The request is pending approval"}}),
        )
    }
    pub fn reject(&self, id: i64) -> Result<Value> {
        let c = self.connection()?;
        if c.execute("UPDATE actions SET status='rejected',approved_by=(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1),approved_at=? WHERE id=? AND status='pending'",params![db::now(),id])?==0{return Err(Error::new(409,"This request does not exist or has already been handled"));}
        db::audit(
            &c,
            "action_rejected",
            Some(&format!("action:{id}")),
            json!({}),
        )?;
        crate::batches::finish(&c)?;
        Ok(json!({"ok":true}))
    }
    pub fn approve(&self, id: i64) -> Result<Value> {
        let c = self.connection()?;
        let action = db::row(
            &c,
            "SELECT * FROM actions WHERE id=? AND status='pending'",
            [id],
        )?
        .ok_or_else(|| {
            Error::new(
                409,
                "This request does not exist or has already been handled",
            )
        })?;
        let payload: Value = serde_json::from_str(s(&action, "payload_json"))?;
        let names = self.validate_servers(&model::server_names(&payload["servers"])?)?;
        let username = s(&action, "target_user");
        self.protect(username, &names)?;
        c.execute("UPDATE actions SET status='approved',approved_by=(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1),approved_at=? WHERE id=? AND status='pending'",params![db::now(),id])?;
        db::audit(
            &c,
            "action_approved",
            Some(&format!("action:{id}")),
            json!({}),
        )?;
        let mut archive: Option<PathBuf> = None;
        let result = (|| -> std::result::Result<(), String> {
            let mut extra = json!({"managed_username":username,"managed_create":s(&action,"action_type")=="create_user"});
            // Every selected host must pass preflight before any account is changed.
            self.run_accounts(&names, "preflight", &extra, 45)?;
            let mut credentials = None;
            if s(&action, "action_type") == "create_user" {
                let generated = self
                    .generate_credentials(id, username, &names)
                    .map_err(|e| e.detail)?;
                archive = Some(generated.path.clone());
                extra["managed_public_key"] = json!(generated.public);
                extra["managed_password_hash"] = json!(generated.password_hash);
                extra["managed_comment"] = payload["full_name"].clone();
                credentials = Some(generated);
            }
            extra["managed_sudo"] = payload["sudo"].clone();
            self.run_accounts(&names, s(&action, "action_type"), &extra, 180)?;
            if let Some(g) = credentials {
                c.execute("UPDATE actions SET status='executed',executed_at=?,error=NULL,public_key=?,key_fingerprint=?,private_key_path=? WHERE id=?",params![db::now(),g.public,g.fingerprint,g.path.to_string_lossy(),id]).map_err(|e|e.to_string())?;
            } else {
                c.execute(
                    "UPDATE actions SET status='executed',executed_at=?,error=NULL WHERE id=?",
                    params![db::now(), id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if let Err(raw) = result {
            if let Some(path) = archive {
                let _ = std::fs::remove_file(path);
            }
            c.execute("UPDATE actions SET status='failed',executed_at=?,error=?,private_key_path=NULL WHERE id=?",params![db::now(),raw,id])?;
            db::audit(
                &c,
                "action_failed",
                Some(&format!("action:{id}")),
                json!({"error":raw}),
            )?;
            crate::batches::finish(&c)?;
            return Err(Error::remote(raw));
        }
        db::audit(
            &c,
            "action_executed",
            Some(&format!("action:{id}")),
            json!({}),
        )?;
        if s(&action, "action_type") == "create_user" && !s(&payload, "full_name").trim().is_empty()
        {
            self.save_profile(&c, username, s(&payload, "full_name").trim())?;
        }
        let warning = match self.scan(&names) {
            Ok(scan) => scan["ok"] != true,
            Err(e) => {
                for name in &names {
                    c.execute("UPDATE servers SET last_scan_at=?,last_scan_status='error',last_scan_error=? WHERE name=?",params![db::now(),e.detail,name])?;
                }
                true
            }
        };
        crate::batches::finish(&c)?;
        Ok(
            json!({"ok":true,"message":"Action completed","warning":if warning{Some("The action completed, but the account list could not refresh. Sync the affected servers again.")}else{None}}),
        )
    }
    pub(crate) fn run_accounts(
        &self,
        names: &[String],
        operation: &str,
        extra: &Value,
        timeout: u64,
    ) -> std::result::Result<(), String> {
        let mut errors = Vec::new();
        for name in names {
            let server = self.server_by_name(name).map_err(|e| e.detail)?;
            let mut payload = extra.clone();
            payload["operation"] = json!(operation);
            payload["ssh_user"] = server["ssh_user"].clone();
            if let Err(e) = self.remote(&server, ssh::ACCOUNTS, &payload, true, timeout) {
                errors.push(format!("{name}: {e}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }
    fn generate_credentials(
        &self,
        id: i64,
        username: &str,
        names: &[String],
    ) -> Result<Credentials> {
        let mut rng = rand::rngs::OsRng;
        let mut key = ssh_key::PrivateKey::random(&mut rng, ssh_key::Algorithm::Ed25519)
            .map_err(|_| Error::new(500, "Could not generate SSH key"))?;
        key.set_comment(format!("{username}@mossentry/action-{id}"));
        let public = key
            .public_key()
            .to_openssh()
            .map_err(|_| Error::new(500, "Could not encode SSH key"))?;
        let fingerprint = key.fingerprint(ssh_key::HashAlg::Sha256).to_string();
        let private = key
            .to_openssh(ssh_key::LineEnding::LF)
            .map_err(|_| Error::new(500, "Could not encode SSH key"))?;
        let mut password: Vec<u8> = (&mut rng).sample_iter(Alphanumeric).take(14).collect();
        password.push(b'A' + rng.gen_range(0..26));
        password.push(b'0' + rng.gen_range(0..10));
        password.shuffle(&mut rng);
        let password = String::from_utf8(password).unwrap();
        let params = sha_crypt::Sha512Params::new(100_000)
            .map_err(|_| Error::new(500, "Could not prepare password hashing"))?;
        let hash = sha_crypt::sha512_simple(&password, &params)
            .map_err(|_| Error::new(500, "Could not generate password hash"))?;
        let key_name = format!("{username}-server-ed25519");
        let mut commands = Vec::new();
        for name in names {
            let server = self.server_by_name(name)?;
            commands.push(format!(
                "ssh {username}@{} -p {} -i {key_name}",
                s(&server, "hostname"),
                n(&server, "port")
            ));
        }
        let instructions=format!("Username: {username}\n\nPassword: {password}\n\nSign-in:\n{}\n\nImportant notes\n\n1. Save the 16-character alphanumeric password immediately. Use passwd to change it after signing in.\n2. The public key has been added to ~/.ssh/authorized_keys. The host currently supports key-based sign-in only.\n3. Run chmod 600 {key_name} before using the key on macOS or Linux.\n4. To use your own key, copy your public key into ~/.ssh/authorized_keys after signing in.\n5. Host information: https://gitlab.deepsynthesis.top/root/gitlab-mannual/-/blob/main/服务器登录指南.md\n",commands.join("\n"));
        let path = self
            .config
            .data
            .join("keys")
            .join(format!("action-{id}-{username}-login.zip"));
        let file = config::private_file(&path, true)?;
        let write_archive = || -> std::result::Result<(), Box<dyn std::error::Error>> {
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o600);
            zip.start_file(&key_name, options)?;
            zip.write_all(private.as_bytes())?;
            zip.start_file("login-instructions.txt", options)?;
            zip.write_all(instructions.as_bytes())?;
            zip.finish()?.sync_all()?;
            Ok(())
        };
        if write_archive().is_err() {
            let _ = std::fs::remove_file(&path);
            return Err(Error::new(500, "Could not write credentials archive"));
        }
        Ok(Credentials {
            public,
            fingerprint,
            password_hash: hash,
            path,
        })
    }
    pub fn credentials_name(&self, id: i64) -> Result<String> {
        let c = self.connection()?;
        let a = available_credentials(&c, id)?;
        Ok(format!("{}-server-login.zip", s(&a, "target_user")))
    }
    /// The caller supplies a path chosen through a native save dialog, never web content.
    /// Cancel and write failure leave the one-time credentials available for retry.
    pub fn save_credentials(&self, id: i64, destination: &Path) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let a = available_credentials(&tx, id)?;
        let source = config::expand_path(s(&a, "private_key_path"));
        let source = source
            .canonicalize()
            .map_err(|_| Error::new(410, "The credentials file no longer exists"))?;
        let keys = self.config.data.join("keys").canonicalize()?;
        if !source.starts_with(&keys) {
            return Err(Error::new(
                500,
                "Credentials are outside the application key directory",
            ));
        }
        // Avoid deleting the user's exported copy or overwriting internal state.
        let parent = destination
            .parent()
            .ok_or_else(|| Error::bad("Invalid destination"))?
            .canonicalize()?;
        if parent.starts_with(self.config.data.canonicalize()?) {
            return Err(Error::bad(
                "Choose a destination outside the application's data directory",
            ));
        }
        if destination.exists() {
            return Err(Error::new(
                409,
                "A file already exists at this location. Choose another filename.",
            ));
        }
        let bytes = std::fs::read(&source)?;
        let mut file = config::private_file(destination, true)?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(destination);
            return Err(error.into());
        }
        tx.execute(
            "UPDATE actions SET private_key_path=NULL,key_downloaded_at=? WHERE id=?",
            params![db::now(), id],
        )?;
        db::audit(
            &tx,
            "private_key_downloaded",
            Some(&format!("action:{id}")),
            json!({"username":a["target_user"],"fingerprint":a["key_fingerprint"]}),
        )?;
        tx.commit()?;
        std::fs::remove_file(source)?;
        Ok(())
    }
}
struct Credentials {
    public: String,
    fingerprint: String,
    password_hash: String,
    path: PathBuf,
}
fn available_credentials(c: &rusqlite::Connection, id: i64) -> Result<Value> {
    let a = db::row(
        c,
        "SELECT * FROM actions WHERE id=? AND action_type='create_user' AND status='executed'",
        [id],
    )?
    .ok_or_else(|| Error::new(404, "No credentials are available for download"))?;
    if !a["key_downloaded_at"].is_null() || s(&a, "private_key_path").is_empty() {
        return Err(Error::new(
            410,
            "Credentials were already downloaded and removed from the manager",
        ));
    }
    Ok(a)
}
