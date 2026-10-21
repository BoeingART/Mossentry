use mossentry::{
    config::{database_path, Config},
    db::{self, n, s},
    error::Result,
    operations,
    service::Service,
    ssh::{self, Transport},
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

type RemoteCall = (String, String, bool, Option<String>);

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<RemoteCall>>,
    fail: AtomicBool,
    fail_create: AtomicBool,
    slow: AtomicBool,
    scan: Mutex<Option<Value>>,
    output: Mutex<Option<Value>>,
}
impl Transport for Fake {
    fn execute(
        &self,
        server: &Value,
        source: &str,
        payload: &Value,
        sudo: bool,
        password: Option<&str>,
        _: u64,
    ) -> std::result::Result<Value, String> {
        self.calls.lock().unwrap().push((
            s(server, "name").into(),
            s(payload, "operation").into(),
            sudo,
            password.map(str::to_string),
        ));
        if self.slow.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(300));
        }
        if self.fail.load(Ordering::SeqCst)
            || self.fail_create.load(Ordering::SeqCst) && payload["operation"] == "create_user"
        {
            return Err("SSH authentication failed".into());
        }
        if source == ssh::RESOURCES {
            return Ok(
                json!({"checked_at":db::now(),"cpu":{"percent":12,"cores":8,"users":[]},"memory":{"total_mb":8000,"used_mb":4000,"percent":50},"disks":[],"gpu":{"status":"unavailable","devices":[],"message":""},"network":{"status":"unavailable","interfaces":[]},"warnings":[]}),
            );
        }
        match s(payload,"operation") {
            "scan_users"=>Ok(self.scan.lock().unwrap().clone().unwrap_or_else(||json!({"passwd":"root:x:0:0::/root:/bin/bash\ndaemon:x:1:1::/:/usr/sbin/nologin\nalice:x:1001:1001::/home/alice:/bin/bash\nsync:x:4:65534::/bin:/bin/sync\n","sudo":"sudo:x:27:alice","effective_sudo":"","creation_times":{"alice":{"created_at":"2020-01-01T00:00:00+00:00","source":"auth_log"}}}))),
            "server_status"=>Ok(json!({"uptime":"12345.90 10000","load":"0.1 0.2 0.3 1/100 999","memory":"MemTotal: 8192000 kB\nMemAvailable: 4096000 kB","disk":"Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 104857600 52428800 52428800 50% /"})),
            "command"|"dry_run"|"inspect"|"services"|"logs"|"restart"=>Ok(self.output.lock().unwrap().clone().unwrap_or_else(||json!({"checked_at":db::now(),"exit_code":0,"stdout":"ok","stderr":"","timed_out":false}))),
            _=>Ok(json!({"ok":true}))
        }
    }
}
struct Fixture {
    service: Arc<Service>,
    remote: Arc<Fake>,
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let remote = Arc::new(Fake::default());
        let service = Service::open(
            Config::isolated(dir.path().join("app")),
            remote.clone(),
            false,
        )
        .unwrap();
        Self {
            service,
            remote,
            dir,
        }
    }
    fn req(&self, path: &str, method: &str, body: Value) -> Result<Value> {
        self.service.request(path, method, body)
    }
    fn add(&self, name: &str) -> i64 {
        n(
            &self.req("/api/servers", "POST", server(name)).unwrap(),
            "id",
        )
    }
    fn dashboard(&self) -> Value {
        self.req("/api/dashboard", "GET", Value::Null).unwrap()
    }
    fn scan(&self) -> Value {
        self.req("/api/scan", "POST", json!({})).unwrap()
    }
    fn queued(&self, username: &str, create: bool) -> i64 {
        let path = if create {
            "/api/actions/create-user"
        } else {
            "/api/actions/user"
        };
        n(&self.req(path,"POST",json!({"username":username,"servers":["one"],"sudo":false,"full_name":"Example","action":"disable_user"})).unwrap(),"action_id")
    }
    fn wait_job(&self, id: i64) -> Value {
        for _ in 0..200 {
            let v = self
                .req(&format!("/api/operations/{id}"), "GET", Value::Null)
                .unwrap();
            if v["status"] != "running" && !self.service.is_busy() {
                return v;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("job did not finish")
    }
}
fn server(name: &str) -> Value {
    json!({"name":name,"hostname":"example.test","port":22,"ssh_user":"operator","key_path":std::env::temp_dir().join("mossentry-fixture-key").to_string_lossy(),"enabled":true,"group_name":"lab","notes":"notes"})
}
#[test]
fn inventory_crud_and_password_identity_rules() {
    let f = Fixture::new();
    let mut b = server("one");
    b["sudo_password"] = json!("secret-value");
    let id = n(&f.req("/api/servers", "POST", b.clone()).unwrap(), "id");
    assert_eq!(f.dashboard()["servers"][0]["has_sudo_password"], 1);
    assert!(!f.dashboard().to_string().contains("secret-value"));
    b["sudo_password"] = json!("");
    b["key_path"] = json!(std::env::temp_dir()
        .join("mossentry-new-key")
        .to_string_lossy());
    f.req(&format!("/api/servers/{id}"), "PUT", b.clone())
        .unwrap();
    assert_eq!(f.dashboard()["servers"][0]["has_sudo_password"], 1);
    b["hostname"] = json!("different.test");
    f.req(&format!("/api/servers/{id}"), "PUT", b.clone())
        .unwrap();
    assert_eq!(f.dashboard()["servers"][0]["has_sudo_password"], 0);
    b["sudo_password"] = json!("replacement");
    f.req(&format!("/api/servers/{id}"), "PUT", b.clone())
        .unwrap();
    b["clear_sudo_password"] = json!(true);
    f.req(&format!("/api/servers/{id}"), "PUT", b).unwrap();
    assert_eq!(f.dashboard()["servers"][0]["has_sudo_password"], 0);
    f.req(&format!("/api/servers/{id}"), "DELETE", Value::Null)
        .unwrap();
    assert!(f.dashboard()["servers"].as_array().unwrap().is_empty());
}
#[test]
fn validation_rejects_host_injection_reserved_names_and_bad_paths() {
    let f = Fixture::new();
    for (key, value) in [
        ("hostname", json!("x; echo unsafe")),
        ("hostname", json!("http://example.com")),
        ("name", json!("all")),
        ("name", json!("../escape")),
        ("ssh_user", json!("root;ls")),
        ("port", json!(0)),
        ("key_path", json!("relative")),
        ("sudo_password", json!("line\nsecret")),
        ("notes", json!("a".repeat(2001))),
    ] {
        let mut b = server("one");
        b[key] = value;
        assert!(f.req("/api/servers", "POST", b).is_err(), "{key}");
    }
    let mut b = server("ipv6");
    b["hostname"] = json!("2001:db8::1");
    f.req("/api/servers", "POST", b).unwrap();
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn duplicate_names_are_conflicts_not_internal_errors() {
    let f = Fixture::new();
    f.add("one");
    assert_eq!(
        f.req("/api/servers", "POST", server("one"))
            .unwrap_err()
            .status,
        409
    );
}
#[test]
fn imports_preview_validate_atomically_and_start_paused() {
    let f = Fixture::new();
    f.add("one");
    let data = json!({"version":1,"servers":[server("one"),server("two")],"preview":true});
    assert_eq!(
        f.req("/api/inventory/import", "POST", data.clone())
            .unwrap()["conflicts"],
        json!(["one"])
    );
    assert_eq!(f.dashboard()["servers"].as_array().unwrap().len(), 1);
    let mut apply = data;
    apply["preview"] = json!(false);
    assert_eq!(
        f.req("/api/inventory/import", "POST", apply)
            .unwrap_err()
            .status,
        409
    );
    f.req(
        "/api/inventory/import",
        "POST",
        json!({"servers":[server("two")],"preview":false}),
    )
    .unwrap();
    assert_eq!(f.dashboard()["servers"][1]["enabled"], 0);
    let exported = f.req("/api/inventory/export", "GET", Value::Null).unwrap();
    assert!(!exported.to_string().contains("sudo_password"));
    let mut secret = server("three");
    secret["sudo_password"] = json!("secret");
    assert!(f
        .req("/api/inventory/import", "POST", json!({"servers":[secret]}))
        .is_err());
    assert!(f
        .req(
            "/api/inventory/import",
            "POST",
            json!({"servers":[server("three"),server("three")]})
        )
        .is_err());
}
#[test]
fn scanning_keeps_all_accounts_but_filters_dashboard_and_preserves_history() {
    let f = Fixture::new();
    let id = f.add("one");
    assert_eq!(f.scan()["users"], 4);
    let d = f.dashboard();
    assert_eq!(d["users"].as_array().unwrap().len(), 4);
    assert_eq!(d["statistics"]["total_unique_users"], 3);
    assert_eq!(d["statistics"]["dated_users"], 1);
    f.req(&format!("/api/servers/{id}"), "DELETE", Value::Null)
        .unwrap();
    assert_eq!(f.dashboard()["statistics"]["total_unique_users"], 3);
    assert!(f.dashboard()["users"].as_array().unwrap().is_empty());
}
#[test]
fn scans_deduplicate_history_across_servers_and_keep_reliable_dates() {
    let f = Fixture::new();
    f.add("one");
    f.add("two");
    f.scan();
    assert_eq!(f.dashboard()["statistics"]["total_unique_users"], 3);
    *f.remote.scan.lock().unwrap() = Some(
        json!({"passwd":"alice:x:1001:1001::/home/alice:/bin/bash","creation_times":{"alice":{"created_at":"2019-01-01T00:00:00+00:00","source":"home_birth"}}}),
    );
    f.scan();
    let c = f.service.connection().unwrap();
    assert_eq!(
        db::row(
            &c,
            "SELECT created_at FROM server_users WHERE username='alice' LIMIT 1",
            []
        )
        .unwrap()
        .unwrap()["created_at"],
        "2020-01-01T00:00:00+00:00"
    );
    assert_eq!(
        f.dashboard()["statistics"]["history"][0]["date"],
        "2020-01-01"
    );
}
#[test]
fn scan_failure_marks_cache_stale_without_deleting_users() {
    let f = Fixture::new();
    f.add("one");
    f.scan();
    f.remote.fail.store(true, Ordering::SeqCst);
    assert_eq!(f.scan()["ok"], false);
    let d = f.dashboard();
    assert_eq!(d["servers"][0]["last_scan_status"], "error");
    assert_eq!(d["users"].as_array().unwrap().len(), 4);
}
#[test]
fn connection_changes_invalidate_cache_but_retain_username_history() {
    let f = Fixture::new();
    let id = f.add("one");
    f.scan();
    let mut b = server("one");
    b["hostname"] = json!("changed.test");
    f.req(&format!("/api/servers/{id}"), "PUT", b).unwrap();
    let d = f.dashboard();
    assert!(d["users"].as_array().unwrap().is_empty());
    assert_eq!(d["servers"][0]["last_scan_status"], "never");
    assert_eq!(d["statistics"]["total_unique_users"], 3);
}
#[test]
fn pending_approvals_block_server_edits_and_deletes() {
    let f = Fixture::new();
    let id = f.add("one");
    let action = f.queued("alice", false);
    assert_eq!(
        f.req(&format!("/api/servers/{id}"), "PUT", server("one"))
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        f.req(&format!("/api/servers/{id}"), "DELETE", Value::Null)
            .unwrap_err()
            .status,
        409
    );
    f.req(&format!("/api/actions/{action}/reject"), "POST", json!({}))
        .unwrap();
    f.req(&format!("/api/servers/{id}"), "DELETE", Value::Null)
        .unwrap();
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn protected_accounts_and_named_exceptions() {
    let f = Fixture::new();
    f.add("one");
    f.scan();
    for name in ["root", "nobody", "operator", "daemon", "bad;name"] {
        assert!(f
            .req(
                "/api/actions/user",
                "POST",
                json!({"username":name,"servers":["one"],"action":"delete_user"})
            )
            .is_err());
    }
    for name in ["srvmgr", "sync", "alice"] {
        f.queued(name, false);
    }
}
#[test]
fn paused_or_unknown_hosts_cannot_be_targeted() {
    let f = Fixture::new();
    let mut b = server("one");
    b["enabled"] = json!(false);
    let id = n(&f.req("/api/servers", "POST", b).unwrap(), "id");
    for op in ["test", "scan", "status", "metrics"] {
        assert!(f
            .req(&format!("/api/servers/{id}/{op}"), "POST", json!({}))
            .is_err());
    }
    for names in [json!([]), json!(["one"]), json!(["missing"])] {
        assert!(f
            .req(
                "/api/actions/create-user",
                "POST",
                json!({"username":"alice","servers":names})
            )
            .is_err());
    }
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn approval_runs_preflight_before_mutation_and_cannot_repeat() {
    let f = Fixture::new();
    f.add("one");
    let id = f.queued("alice", false);
    let route = format!("/api/actions/{id}/approve");
    f.req(&route, "POST", json!({})).unwrap();
    let calls = f.remote.calls.lock().unwrap();
    assert_eq!(calls[0].1, "preflight");
    assert_eq!(calls[1].1, "disable_user");
    drop(calls);
    assert_eq!(f.dashboard()["actions"][0]["status"], "executed");
    assert_eq!(f.req(&route, "POST", json!({})).unwrap_err().status, 409);
}
#[test]
fn preflight_failure_never_mutates_or_leaves_keys() {
    let f = Fixture::new();
    f.add("one");
    let id = f.queued("alice", true);
    f.remote.fail.store(true, Ordering::SeqCst);
    assert!(f
        .req(&format!("/api/actions/{id}/approve"), "POST", json!({}))
        .is_err());
    assert_eq!(f.remote.calls.lock().unwrap().len(), 1);
    assert_eq!(f.dashboard()["actions"][0]["status"], "failed");
    assert_eq!(
        std::fs::read_dir(f.service.config.data.join("keys"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn failed_create_removes_generated_archive() {
    let f = Fixture::new();
    f.add("one");
    let id = f.queued("alice", true);
    f.remote.fail_create.store(true, Ordering::SeqCst);
    assert!(f
        .req(&format!("/api/actions/{id}/approve"), "POST", json!({}))
        .is_err());
    assert_eq!(
        std::fs::read_dir(f.service.config.data.join("keys"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn credentials_contain_valid_ed25519_password_and_are_exported_once() {
    let f = Fixture::new();
    f.add("one");
    let id = f.queued("alice", true);
    f.req(&format!("/api/actions/{id}/approve"), "POST", json!({}))
        .unwrap();
    assert_eq!(f.dashboard()["actions"][0]["private_key_ready"], true);
    let output = f.dir.path().join("credentials.zip");
    f.service.save_credentials(id, &output).unwrap();
    assert_eq!(
        f.service
            .save_credentials(id, &f.dir.path().join("twice.zip"))
            .unwrap_err()
            .status,
        410
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
    let mut private = String::new();
    zip.by_name("alice-server-ed25519")
        .unwrap()
        .read_to_string(&mut private)
        .unwrap();
    let key = ssh_key::PrivateKey::from_openssh(private).unwrap();
    assert_eq!(key.algorithm(), ssh_key::Algorithm::Ed25519);
    assert_eq!(
        key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
        f.dashboard()["actions"][0]["key_fingerprint"]
    );
    let mut instructions = String::new();
    zip.by_name("login-instructions.txt")
        .unwrap()
        .read_to_string(&mut instructions)
        .unwrap();
    let password = instructions
        .lines()
        .find_map(|l| l.strip_prefix("Password: "))
        .unwrap();
    assert_eq!(password.len(), 16);
    assert!(password.bytes().all(|b| b.is_ascii_alphanumeric()));
    assert!(password.bytes().any(|b| b.is_ascii_digit()));
    assert!(password.bytes().any(|b| b.is_ascii_alphabetic()));
    assert!(!f.dashboard().to_string().contains(password));
    assert_eq!(f.dashboard()["actions"][0]["private_key_ready"], false);
    assert_eq!(
        std::fs::read_dir(f.service.config.data.join("keys"))
            .unwrap()
            .count(),
        0
    );
}
#[test]
fn failed_export_keeps_credentials_available() {
    let f = Fixture::new();
    f.add("one");
    let id = f.queued("alice", true);
    f.req(&format!("/api/actions/{id}/approve"), "POST", json!({}))
        .unwrap();
    let destination = f.dir.path().join("existing.zip");
    std::fs::write(&destination, b"existing").unwrap();
    assert_eq!(
        f.service
            .save_credentials(id, &destination)
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"existing");
    assert_eq!(f.dashboard()["actions"][0]["private_key_ready"], true);
    assert!(f
        .service
        .save_credentials(id, &f.service.config.data.join("keys/overwrite.zip"))
        .is_err());
    assert_eq!(f.dashboard()["actions"][0]["private_key_ready"], true);
}
#[test]
fn profile_edit_and_clear_are_local() {
    let f = Fixture::new();
    f.add("one");
    f.scan();
    f.req(
        "/api/users/alice/profile",
        "PUT",
        json!({"full_name":" 张三 "}),
    )
    .unwrap();
    assert!(f.dashboard()["users"]
        .as_array()
        .unwrap()
        .iter()
        .any(|u| u["full_name"] == "张三"));
    f.req("/api/users/alice/profile", "PUT", json!({"full_name":""}))
        .unwrap();
    assert!(f
        .req(
            "/api/users/missing/profile",
            "PUT",
            json!({"full_name":"x"})
        )
        .is_err());
}
#[test]
fn status_and_connection_test_preserve_contract() {
    let f = Fixture::new();
    let id = f.add("one");
    assert_eq!(
        f.req(&format!("/api/servers/{id}/test"), "POST", json!({}))
            .unwrap()["ok"],
        true
    );
    let v = f
        .req(&format!("/api/servers/{id}/status"), "POST", json!({}))
        .unwrap();
    assert_eq!(v["uptime_seconds"], 12345);
    assert_eq!(v["memory_total_mb"], 8000.0);
    assert_eq!(v["disk_percent"], 50.0);
}
#[test]
fn monitoring_cache_is_separate_from_management_lock_and_connection_scoped() {
    let f = Fixture::new();
    let id = f.add("one");
    let route = format!("/api/servers/{id}/metrics");
    let guard = f.service.acquire().unwrap();
    f.req(&route, "POST", json!({})).unwrap();
    f.req(&route, "POST", json!({})).unwrap();
    assert_eq!(f.remote.calls.lock().unwrap().len(), 1);
    drop(guard);
    let mut b = server("one");
    b["hostname"] = json!("another.test");
    f.req(&format!("/api/servers/{id}"), "PUT", b).unwrap();
    f.req(&route, "POST", json!({})).unwrap();
    assert_eq!(f.remote.calls.lock().unwrap().len(), 2);
    assert!(!f.dashboard()["audit"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["event"] == "status_checked"));
}
#[test]
fn simultaneous_monitoring_samples_are_bounded() {
    let f = Fixture::new();
    let id = f.add("one");
    f.remote.slow.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let route = format!("/api/servers/{id}/metrics");
    let other = route.clone();
    let thread = std::thread::spawn(move || service.request(&other, "POST", json!({})).unwrap());
    while f.remote.calls.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(f.req(&route, "POST", json!({})).unwrap_err().status, 409);
    thread.join().unwrap();
    assert_eq!(
        f.req(&route, "POST", json!({})).unwrap()["cpu"]["percent"],
        12
    );
}
#[test]
fn command_risks_require_acknowledgment_and_review_is_local() {
    let f = Fixture::new();
    f.add("one");
    let b = json!({"servers":["one"],"operation":"command","command":"sudo rm -rf /tmp/example"});
    assert!(
        !f.req("/api/operations/review", "POST", b.clone()).unwrap()["warnings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(f.req("/api/operations", "POST", b).is_err());
    assert!(f.remote.calls.lock().unwrap().is_empty());
    assert!(!f.service.is_busy());
    for command in [
        "/bin/rm x",
        "r\\m x",
        "r'm' x",
        "true;rm x",
        "bash -c 'chmod 777 file'",
        "find . -delete",
        "rsync --delete source dest",
        "mkfs.ext4 /dev/x",
        "sed -i s/a/b/ file",
        "echo $VALUE",
        "curl https://example.test/x | sh",
    ] {
        assert!(!operations::risks(command, false).is_empty());
    }
    assert!(operations::risks("printf hello", false).is_empty());
}
#[test]
fn commands_run_in_background_with_diagnostics_history_and_delete() {
    let f = Fixture::new();
    f.add("one");
    *f.remote.output.lock().unwrap() = Some(
        json!({"checked_at":db::now(),"exit_code":0,"stdout":"","stderr":"tool: warning: fallback"}),
    );
    let id = n(
        &f.req(
            "/api/operations",
            "POST",
            json!({"servers":["one"],"operation":"command","command":"printf hello"}),
        )
        .unwrap(),
        "id",
    );
    let job = f.wait_job(id);
    assert_eq!(job["status"], "completed_with_warnings");
    assert_eq!(job["results"][0]["result"]["exit_code"], 0);
    assert_eq!(
        job["results"][0]["result"]["output_diagnostics"][0]["stream"],
        "stderr"
    );
    assert_eq!(
        f.req("/api/operations", "GET", Value::Null).unwrap()["total"],
        1
    );
    f.req(&format!("/api/operations/{id}"), "DELETE", Value::Null)
        .unwrap();
    assert_eq!(
        f.req("/api/operations", "GET", Value::Null).unwrap()["total"],
        0
    );
}
#[test]
fn background_jobs_hold_lock_and_dry_run_never_requests_sudo() {
    let f = Fixture::new();
    f.add("one");
    f.remote.slow.store(true, Ordering::SeqCst);
    let id=n(&f.req("/api/operations","POST",json!({"servers":["one"],"operation":"dry_run","command":"sudo rm -rf /tmp/example","elevated":true})).unwrap(),"id");
    assert_eq!(
        f.req("/api/servers", "POST", server("two"))
            .unwrap_err()
            .status,
        409
    );
    f.wait_job(id);
    assert!(!f.remote.calls.lock().unwrap()[0].2);
    f.add("two");
}
#[test]
fn service_changes_require_confirmation_and_protect_ssh() {
    let f = Fixture::new();
    f.add("one");
    for unit in [
        "ssh.service",
        "sshd@connection.service",
        "NetworkManager.service",
    ] {
        assert!(f.req("/api/operations","POST",json!({"servers":["one"],"operation":"restart","unit":unit,"confirmation":format!("restart {unit}")})).is_err());
    }
    assert!(f
        .req(
            "/api/operations",
            "POST",
            json!({"servers":["one"],"operation":"restart","unit":"nginx.service"})
        )
        .is_err());
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn diagnostics_preserve_output_cap_matches_and_do_not_treat_stderr_as_failure() {
    let v = operations::analyze(
        json!({"exit_code":0,"stdout":"0 errors\n*.error.log","stderr":"progress"}),
    );
    assert_eq!(operations::result_status(&v), "completed");
    let v = operations::analyze(json!({"exit_code":0,"stdout":"tool: warning: thing\n".repeat(8)}));
    assert_eq!(v["output_diagnostics"][0]["count"], 8);
    assert_eq!(
        v["output_diagnostics"][0]["matches"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(operations::result_status(&json!({"exit_code":1})), "failed");
    assert_eq!(
        operations::result_status(&json!({"syntax_ok":false})),
        "failed"
    );
    assert_eq!(
        operations::result_status(&json!({"timed_out":true})),
        "failed"
    );
}
#[test]
fn data_lock_prevents_concurrent_instances() {
    let f = Fixture::new();
    assert!(Service::open(f.service.config.clone(), Arc::new(Fake::default()), false).is_err());
}
#[test]
fn appearance_migrates_legacy_file_and_persists() {
    let f = Fixture::new();
    std::fs::write(
        f.service.config.home.join("appearance.json"),
        r#"{"language":"zh","colorScheme":"dark","invalid":"x"}"#,
    )
    .unwrap();
    assert_eq!(
        f.service.appearance().unwrap(),
        json!({"language":"zh","colorScheme":"dark"})
    );
    f.service.set_preference("colorScheme", "light").unwrap();
    assert_eq!(
        f.service.appearance().unwrap(),
        json!({"language":"zh","colorScheme":"light"})
    );
    assert!(f.service.set_preference("language", "invalid").is_err());
    std::fs::write(f.service.config.home.join("appearance.json"), b"broken").unwrap();
    assert_eq!(f.service.appearance().unwrap()["colorScheme"], "light");
}
#[test]
fn startup_recovers_interrupted_jobs_and_approvals_without_rerunning() {
    let f = Fixture::new();
    f.add("one");
    let action = f.queued("alice", false);
    let c = f.service.connection().unwrap();
    c.execute("UPDATE actions SET status='approved' WHERE id=?", [action])
        .unwrap();
    c.execute("INSERT INTO operation_jobs(operation,payload_json,status,created_at) VALUES('command','{}','running',?)",[db::now()]).unwrap();
    let job = c.last_insert_rowid();
    c.execute(
        "INSERT INTO operation_results(job_id,server_name,status) VALUES(?,'one','running')",
        [job],
    )
    .unwrap();
    drop(c);
    let config = f.service.config.clone();
    drop(f.service);
    let svc = Service::open(config, f.remote.clone(), false).unwrap();
    let d = svc.request("/api/dashboard", "GET", Value::Null).unwrap();
    assert_eq!(d["actions"][0]["status"], "failed");
    assert_eq!(
        svc.request(&format!("/api/operations/{job}"), "GET", Value::Null)
            .unwrap()["status"],
        "interrupted"
    );
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn old_database_migrates_in_place_and_deleted_inventory_stays_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::isolated(dir.path().join("app"));
    std::fs::create_dir_all(&config.data).unwrap();
    let legacy = config.data.join("server_manager.db");
    let c = rusqlite::Connection::open(&legacy).unwrap();
    c.execute_batch(include_str!("../src/schema.sql")).unwrap();
    c.execute(
        "INSERT INTO settings(key,value) VALUES('servers_seeded','1')",
        [],
    )
    .unwrap();
    drop(c);
    config.db = database_path(&config.data);
    assert_eq!(config.db, legacy);
    let service = Service::open(config, Arc::new(Fake::default()), true).unwrap();
    let d = service
        .request("/api/dashboard", "GET", Value::Null)
        .unwrap();
    assert!(d["servers"].as_array().unwrap().is_empty());
    assert!(!service.config.data.join("mossentry.db").exists());
    assert!(db::rows(
        &service.connection().unwrap(),
        "PRAGMA table_info(servers)",
        []
    )
    .unwrap()
    .iter()
    .any(|v| v["name"] == "group_name"));
}
#[test]
fn history_backfill_keeps_failure_and_adds_warning_without_execution() {
    let f = Fixture::new();
    let c = f.service.connection().unwrap();
    c.execute(
        "DELETE FROM settings WHERE key='operation_output_diagnostics_version'",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO operation_jobs(operation,payload_json,status,created_at) VALUES('command','{}','completed',?)",[db::now()]).unwrap();
    let id = c.last_insert_rowid();
    c.execute("INSERT INTO operation_results(job_id,server_name,status,result_json) VALUES(?,'one','completed',?)",params![id,json!({"exit_code":0,"stdout":"dpkg: warning: fallback","stderr":""}).to_string()]).unwrap();
    operations::backfill(&c).unwrap();
    assert_eq!(
        operations::detail(&c, id).unwrap()["status"],
        "completed_with_warnings"
    );
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn private_storage_modes_and_secret_redaction() {
    let f = Fixture::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f.service.config.data)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&f.service.config.db)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        ssh::redact("prefix secret suffix", Some("secret")),
        "prefix [redacted] suffix"
    );
    assert!(ssh::framed_program(
        "from __future__ import annotations\nprint('safe')",
        "marker"
    )
    .contains("exec(compile("));
}

#[test]
fn malformed_scan_preserves_cache_and_marks_it_stale() {
    let f = Fixture::new();
    f.add("one");
    f.scan();
    *f.remote.scan.lock().unwrap() = Some(json!({"unexpected":"response"}));
    assert_eq!(f.scan()["ok"], false);
    assert_eq!(f.dashboard()["servers"][0]["last_scan_status"], "error");
    assert_eq!(f.dashboard()["users"].as_array().unwrap().len(), 4);
}

#[test]
fn approval_list_collects_multiple_operations_and_approves_once() {
    let f = Fixture::new();
    f.add("one");
    let first = f.queued("alice", false);
    let second = f.queued("bob", false);
    assert_ne!(first, second);
    assert_eq!(f.queued("alice", false), first); // repeat clicks cannot duplicate an item
    let dashboard = f.dashboard();
    assert_eq!(dashboard["approval_batches"].as_array().unwrap().len(), 1);
    assert_eq!(dashboard["statistics"]["pending_approvals"], 1);
    let batch = n(&dashboard["approval_batches"][0], "id");
    assert_eq!(dashboard["actions"][0]["batch_id"], batch);
    let result = f
        .req(
            &format!("/api/approval-batches/{batch}/approve"),
            "POST",
            json!({}),
        )
        .unwrap();
    assert_eq!(result["completed"], 2);
    assert_eq!(result["failed"], 0);
    assert_eq!(f.dashboard()["approval_batches"][0]["status"], "executed");
    assert!(f
        .req(
            &format!("/api/approval-batches/{batch}/approve"),
            "POST",
            json!({})
        )
        .is_err());
    let calls = f.remote.calls.lock().unwrap();
    assert_eq!(calls[0].1, "preflight");
    assert_eq!(calls[1].1, "preflight");
    assert_eq!(
        calls.iter().filter(|call| call.1 == "disable_user").count(),
        2
    );
    drop(calls);
    f.queued("chen", false);
    assert_ne!(f.dashboard()["actions"][0]["batch_id"], batch);
}
#[test]
fn approval_list_preflight_failure_never_partially_executes() {
    let f = Fixture::new();
    f.add("one");
    f.queued("alice", false);
    f.queued("bob", false);
    let batch = n(&f.dashboard()["approval_batches"][0], "id");
    f.remote.fail.store(true, Ordering::SeqCst);
    assert!(f
        .req(
            &format!("/api/approval-batches/{batch}/approve"),
            "POST",
            json!({})
        )
        .is_err());
    assert!(f
        .remote
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|call| call.1 == "preflight"));
    let dashboard = f.dashboard();
    assert_eq!(dashboard["approval_batches"][0]["status"], "failed");
    assert!(dashboard["actions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|action| action["status"] == "failed"));
}
#[test]
fn approval_list_retains_per_item_results_and_credentials_on_partial_failure() {
    let f = Fixture::new();
    f.add("one");
    f.queued("alice", false);
    f.queued("bob", true);
    f.remote.fail_create.store(true, Ordering::SeqCst);
    let batch = n(&f.dashboard()["approval_batches"][0], "id");
    let result = f
        .req(
            &format!("/api/approval-batches/{batch}/approve"),
            "POST",
            json!({}),
        )
        .unwrap();
    assert_eq!(result["completed"], 1);
    assert_eq!(result["failed"], 1);
    assert_eq!(f.dashboard()["approval_batches"][0]["status"], "failed");
    assert_eq!(f.dashboard()["actions"][0]["private_key_ready"], false);
    assert_eq!(f.dashboard()["actions"][1]["status"], "executed");
}
#[test]
fn approval_list_can_remove_an_item_and_reject_remaining_items_without_remote_calls() {
    let f = Fixture::new();
    f.add("one");
    let item = f.queued("alice", false);
    f.queued("bob", false);
    let batch = n(&f.dashboard()["approval_batches"][0], "id");
    f.req(
        &format!("/api/approval-batches/{batch}/items/{item}"),
        "DELETE",
        json!({}),
    )
    .unwrap();
    assert_eq!(f.dashboard()["approval_batches"][0]["status"], "pending");
    f.req(
        &format!("/api/approval-batches/{batch}/reject"),
        "POST",
        json!({}),
    )
    .unwrap();
    assert_eq!(f.dashboard()["approval_batches"][0]["status"], "rejected");
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
#[test]
fn legacy_pending_items_migrate_to_one_list_and_interrupted_lists_do_not_resume() {
    let f = Fixture::new();
    f.add("one");
    f.queued("alice", false);
    f.queued("bob", false);
    let c = f.service.connection().unwrap();
    c.execute("UPDATE actions SET batch_id=NULL", []).unwrap();
    c.execute("DELETE FROM approval_batches", []).unwrap();
    drop(c);
    let config = f.service.config.clone();
    drop(f.service);
    let svc = Service::open(config.clone(), f.remote.clone(), false).unwrap();
    let dashboard = svc.request("/api/dashboard", "GET", Value::Null).unwrap();
    assert_eq!(dashboard["approval_batches"].as_array().unwrap().len(), 1);
    let c = svc.connection().unwrap();
    c.execute("UPDATE approval_batches SET status='approved'", [])
        .unwrap();
    drop(c);
    drop(svc);
    let svc = Service::open(config, f.remote.clone(), false).unwrap();
    let dashboard = svc.request("/api/dashboard", "GET", Value::Null).unwrap();
    assert_eq!(dashboard["approval_batches"][0]["status"], "failed");
    assert!(dashboard["actions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["status"] == "failed"));
    assert!(f.remote.calls.lock().unwrap().is_empty());
}
