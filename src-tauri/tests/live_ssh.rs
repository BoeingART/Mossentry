//! Opt-in, loopback-only integration against scripts/test-ssh.py's disposable container.
use mossentry::{
    config::Config,
    db::{n, s},
    service::Service,
    ssh::{NativeSsh, Transport},
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
#[test]
#[ignore = "requires the isolated Docker SSH fixture; run npm run test:ssh"]
fn loopback_ssh_transport_and_complete_account_lifecycle() {
    let port = std::env::var("MOSSENTRY_TEST_SSH_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let directory = PathBuf::from(std::env::var("MOSSENTRY_TEST_SSH_DIR").unwrap());
    assert!(directory.join("disposable-fixture").is_file());
    let ssh = Arc::new(NativeSsh::with_known_hosts(directory.join("known_hosts")));
    let home = tempfile::tempdir().unwrap();
    let service = Service::open(Config::isolated(home.path().join("app")), ssh.clone()).unwrap();
    let server = json!({"name":"fixture","hostname":"127.0.0.1","port":port,"ssh_user":"operator","key_path":directory.join("id_ed25519").to_string_lossy(),"sudo_password":"fixture-password"});
    let id = n(
        &service
            .request("/api/servers", "POST", server.clone())
            .unwrap(),
        "id",
    );
    let connection = service
        .request(&format!("/api/servers/{id}/test"), "POST", json!({}))
        .unwrap();
    assert_eq!(connection["ok"], true, "{connection}");
    for kind in ["rsa", "ecdsa", "hashed"] {
        let alternate = NativeSsh::with_known_hosts(directory.join(format!("known_hosts_{kind}")));
        assert_eq!(
            alternate
                .execute(&server, "print('{}')", &json!({}), false, None, 10)
                .unwrap(),
            json!({})
        );
    }
    // Unknown/changed fingerprints must fail before user authentication or commands.
    let bad = NativeSsh::with_known_hosts(directory.join("wrong_known_hosts"));
    assert!(bad
        .execute(&server, "print('{}')", &json!({}), false, None, 10)
        .unwrap_err()
        .to_lowercase()
        .contains("host key"));
    let echo="from __future__ import annotations\nimport sys,json\np=json.loads(sys.stdin.readline())\nsys.stderr.write('notice\\n')\nprint(json.dumps(p))";
    let payload = json!({"quoted":"' ; $(touch /tmp/should-not-exist)","unicode":"中文"});
    assert_eq!(
        ssh.execute(&server, echo, &payload, false, None, 10)
            .unwrap(),
        payload
    );
    assert!(ssh
        .execute(
            &server,
            "import time;time.sleep(5)",
            &json!({}),
            false,
            None,
            1
        )
        .unwrap_err()
        .contains("timed out"));
    assert!(ssh
        .execute(&server, echo, &payload, true, Some("wrong-password"), 10)
        .is_err());
    // This sudo rule is passwordless; a provided password must not corrupt payload framing.
    let nopass = json!({"hostname":"127.0.0.1","port":port,"ssh_user":"nopass","key_path":server["key_path"]});
    assert_eq!(
        ssh.execute(&nopass, echo, &payload, true, Some("unused-password"), 10)
            .unwrap(),
        payload
    );
    let queue = |action: &str, username: &str| {
        let body = json!({"username":username,"servers":["fixture"],"action":action,"sudo":action=="set_sudo","full_name":"SSH fixture"});
        let route = if action == "create_user" {
            "/api/actions/create-user"
        } else {
            "/api/actions/user"
        };
        let aid = n(&service.request(route, "POST", body).unwrap(), "action_id");
        service
            .request(&format!("/api/actions/{aid}/approve"), "POST", json!({}))
            .unwrap();
        aid
    };
    let created = queue("create_user", "fixture_person");
    let dashboard = || {
        service
            .request("/api/dashboard", "GET", Value::Null)
            .unwrap()
    };
    let user = || {
        dashboard()["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["username"] == "fixture_person")
            .unwrap()
            .clone()
    };
    assert_eq!(user()["is_disabled"], 0);
    service
        .save_credentials(created, &home.path().join("credentials.zip"))
        .unwrap();
    queue("disable_user", "fixture_person");
    assert_eq!(user()["is_disabled"], 1);
    queue("enable_user", "fixture_person");
    assert_eq!(user()["is_disabled"], 0);
    queue("set_sudo", "fixture_person");
    assert_eq!(user()["is_sudo"], 1);
    let metrics = service
        .request(&format!("/api/servers/{id}/metrics"), "POST", json!({}))
        .unwrap();
    assert!(metrics["cpu"]["cores"].as_u64().unwrap() > 0);
    assert!(metrics["memory"]["total_mb"].as_f64().unwrap() > 0.);
    let status = service
        .request(&format!("/api/servers/{id}/status"), "POST", json!({}))
        .unwrap();
    assert!(status["uptime_seconds"].as_u64().unwrap() > 0);
    let job=n(&service.request("/api/operations","POST",json!({"operation":"command","servers":["fixture"],"risk_acknowledged":true,"command":"printf 'hello\\n'; printf 'tool: warning: fixture\\n' >&2"})).unwrap(),"id");
    let mut done = Value::Null;
    for _ in 0..300 {
        let value = service
            .request(&format!("/api/operations/{job}"), "GET", Value::Null)
            .unwrap();
        if value["status"] != "running" {
            done = value;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(done["status"], "completed_with_warnings", "{done}");
    assert_eq!(done["results"][0]["result"]["stdout"], "hello\n");
    while service.is_busy() {
        std::thread::sleep(Duration::from_millis(10));
    }
    queue("delete_user", "fixture_person");
    assert!(!dashboard()["users"]
        .as_array()
        .unwrap()
        .iter()
        .any(|u| u["username"] == "fixture_person"));
    let check=ssh.execute(&server,"import os,json\nprint(json.dumps({'home':os.path.isdir('/home/fixture_person'),'injected':os.path.exists('/tmp/should-not-exist')}))",&json!({}),false,None,10).unwrap();
    assert_eq!(check, json!({"home":true,"injected":false}));
    assert_eq!(s(&dashboard()["actions"][0], "status"), "executed");
}

#[test]
#[ignore = "requires the isolated Docker SSH fixture; run npm run test:ssh"]
fn openssh_direct_and_imported_multiple_jump_hosts_preserve_framing_and_host_trust() {
    use mossentry::ssh_config::SshConfig;
    let port = std::env::var("MOSSENTRY_TEST_SSH_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let directory = PathBuf::from(std::env::var("MOSSENTRY_TEST_SSH_DIR").unwrap());
    assert!(directory.join("disposable-fixture").is_file());
    let ssh = NativeSsh::with_known_hosts(directory.join("known_hosts"));
    let mut direct = json!({"hostname":"127.0.0.1","port":port,"ssh_user":"operator","key_path":directory.join("id_ed25519"),"ssh_backend":"openssh"});
    let echo = "import sys,json\np=json.loads(sys.stdin.readline())\nsys.stderr.write('notice\\n' * 10000)\nprint(json.dumps(p))";
    let payload =
        json!({"value":"中文 ' ; $(touch /tmp/should-not-exist)","large":"x".repeat(200_000)});
    assert_eq!(
        ssh.execute(&direct, echo, &payload, true, Some("fixture-password"), 20)
            .unwrap(),
        payload
    );
    let bad = NativeSsh::with_known_hosts(directory.join("wrong_known_hosts"));
    assert!(bad
        .execute(&direct, echo, &payload, false, None, 10)
        .unwrap_err()
        .to_lowercase()
        .contains("host key"));
    assert!(ssh
        .execute(
            &direct,
            "import time;time.sleep(5)",
            &json!({}),
            false,
            None,
            1
        )
        .unwrap_err()
        .contains("timed out"));
    direct["ssh_user"] = json!("nopass");
    assert_eq!(
        ssh.execute(&direct, echo, &payload, true, Some("unused-password"), 20)
            .unwrap(),
        payload
    );

    #[cfg(unix)]
    {
        struct Agent(std::process::Child);
        impl Drop for Agent {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let socket = directory.join("agent.sock");
        let _agent = Agent(
            std::process::Command::new("/usr/bin/ssh-agent")
                .args(["-D", "-a"])
                .arg(&socket)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        for _ in 0..200 {
            if socket.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let add = std::process::Command::new("/usr/bin/ssh-add")
            .arg(directory.join("id_ed25519"))
            .env("SSH_AUTH_SOCK", &socket)
            .output()
            .unwrap();
        assert!(
            add.status.success(),
            "{}",
            String::from_utf8_lossy(&add.stderr)
        );
        let mut agent_server = direct.clone();
        agent_server["ssh_user"] = json!("operator");
        agent_server["key_path"] = json!("");
        agent_server["ssh_options"] = json!(format!(
            "IdentityAgent {}\nIdentityFile none\n",
            mossentry::ssh_config::quote(&socket.to_string_lossy())
        ));
        assert_eq!(
            ssh.execute(&agent_server, echo, &payload, false, None, 20)
                .unwrap(),
            payload
        );
    }

    let path = directory.join("jump-config");
    let key = mossentry::ssh_config::quote(&directory.join("id_ed25519").to_string_lossy());
    std::fs::write(&path, format!("Host target\n HostName 127.0.0.1\n Port 22\n User operator\n IdentityFile {key}\n ProxyJump relay,inner\nHost relay\n HostName 127.0.0.1\n Port {port}\n User operator\n IdentityFile {key}\nHost inner\n HostName 127.0.0.1\n Port 22\n User operator\n IdentityFile {key}\n")).unwrap();
    let imported = SshConfig::load(&path).unwrap().import().unwrap();
    let target = serde_json::to_value(&imported.servers[0]).unwrap();
    assert_eq!(
        ssh.execute(&target, echo, &payload, true, Some("fixture-password"), 20)
            .unwrap(),
        payload
    );
    assert!(ssh
        .execute(
            &target,
            "import time;time.sleep(5)",
            &json!({}),
            false,
            None,
            1
        )
        .unwrap_err()
        .contains("timed out"));
    assert!(ssh
        .execute(
            &target,
            "print('x' * 17_000_000)",
            &json!({}),
            false,
            None,
            20
        )
        .unwrap_err()
        .contains("size limit"));

    let mut command = target.clone();
    let proxy = format!("ProxyCommand {} -F {} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile={} -W %h:%p relay\n", shell_words::quote(&mossentry::openssh::executable().to_string_lossy()), shell_words::quote(&path.to_string_lossy()), shell_words::quote(&directory.join("known_hosts").to_string_lossy()));
    command["ssh_options"] = json!(proxy);
    assert_eq!(
        ssh.execute(&command, echo, &payload, false, None, 20)
            .unwrap(),
        payload
    );
}
