use mossentry::ssh_config::{words, SshConfig};
use std::fs;

#[test]
fn aliases_inherit_first_values_and_accumulate_identity_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    fs::write(&path, "# config\nHost GPU.One backup\n HostName=example.test\n Port 2202\n User operator\n IdentityFile \"~/.ssh/key with spaces\"\nHost gpu.* !backup\n Port 99\nHost *\n Port 22\n IdentityFile ~/.ssh/second\n").unwrap();
    let config = SshConfig::load(&path).unwrap();
    assert_eq!(config.aliases, ["GPU.One", "backup"]);
    let resolved = config.resolve("GPU.One").unwrap();
    assert_eq!(resolved["port"], ["2202"]);
    assert_eq!(resolved["identityfile"].len(), 2);
    let import = config.import().unwrap();
    assert_eq!(import.servers[0].name, "gpu_one");
    assert_eq!(import.servers[0].hostname, "example.test");
    assert_eq!(import.servers[0].port, 2202);
    assert!(import.servers.iter().all(|server| server.enabled));
    assert_eq!(import.servers[0].ssh_alias, "GPU.One");
    assert!(import.servers[0].key_path.ends_with("key with spaces"));
}

#[test]
fn include_files_are_sorted_and_change_the_preview_revision() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("01.conf"),
        "Host one\n HostName first.test\n User operator\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("02.conf"),
        "Host two\n HostName second.test\n User operator\n",
    )
    .unwrap();
    let path = dir.path().join("config");
    fs::write(
        &path,
        format!(
            "Include {}/*.conf\nHost *\n Port 2222\n",
            dir.path().display()
        ),
    )
    .unwrap();
    let original = SshConfig::load(&path).unwrap();
    assert_eq!(original.aliases, ["one", "two"]);
    assert_eq!(original.import().unwrap().servers[1].port, 2222);
    fs::write(
        dir.path().join("02.conf"),
        "Host two\n HostName changed.test\n User operator\n",
    )
    .unwrap();
    assert_ne!(SshConfig::load(&path).unwrap().revision, original.revision);
    fs::write(&path, format!("Include {}\n", path.display())).unwrap();
    assert!(SshConfig::load(&path)
        .err()
        .unwrap()
        .detail
        .contains("cycle"));
}

#[test]
fn importing_never_executes_match_commands_and_windows_paths_keep_backslashes() {
    assert_eq!(
        words(r#""C:\Users\Me\.ssh\key with spaces" # comment"#).unwrap(),
        [r"C:\Users\Me\.ssh\key with spaces"]
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    let sentinel = dir.path().join("executed");
    fs::write(
        &path,
        format!(
            "Host one\n User operator\nMatch exec \"touch {}\"\n",
            sentinel.display()
        ),
    )
    .unwrap();
    assert!(SshConfig::load(&path).is_err());
    assert!(!sentinel.exists());
}

#[test]
fn login_settings_and_nested_jump_aliases_are_saved_without_running_commands() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config");
    fs::write(&path, "Host target\n HostName target.test\n User Research.User\n ProxyJump user@relay:2222\n IdentityFile ~/.ssh/first\n IdentityFile ~/.ssh/second\n CertificateFile ~/.ssh/certificate.pub\n IdentityAgent SSH_AUTH_SOCK\n IdentitiesOnly yes\n UserKnownHostsFile ~/.ssh/lab_hosts\n HostKeyAlias lab-target\n ConnectTimeout 15\n ServerAliveInterval 30\n ServerAliveCountMax 5\n Compression yes\n ForwardAgent no\nHost relay\n HostName relay.test\n User jump\n IdentityFile ~/.ssh/relay-key\n ProxyJump entry\nHost entry\n HostName entry.test\n User operator\nHost *\n Port 22\n").unwrap();
    let imported = SshConfig::load(&path).unwrap().import().unwrap();
    let target = &imported.servers[0];
    assert_eq!(target.ssh_backend, "openssh");
    assert_eq!(target.ssh_alias, "target");
    assert_eq!(target.ssh_user, "Research.User");
    for option in [
        "proxyjump user@relay:2222",
        "identityfile ~/.ssh/second",
        "certificatefile ~/.ssh/certificate.pub",
        "identityagent SSH_AUTH_SOCK",
        "compression yes",
    ] {
        assert!(target.ssh_options.contains(option), "{option}");
    }
    assert!(target.ssh_jump_config.contains("Host relay\n"));
    assert!(target
        .ssh_jump_config
        .contains("identityfile ~/.ssh/relay-key"));
    assert!(target.ssh_jump_config.contains("Host entry\n"));
    assert!(imported.warnings.is_empty());
    fs::write(&path, "Host target\n User operator\n ProxyJump relay\nHost relay\n User operator\n ProxyJump target\n").unwrap();
    assert!(SshConfig::load(&path)
        .unwrap()
        .import()
        .err()
        .unwrap()
        .detail
        .contains("cycle"));
}

#[test]
fn local_hooks_and_remote_commands_cannot_be_saved_as_login_options() {
    use mossentry::ssh_config::validate_options;
    for text in [
        "LocalCommand touch sentinel",
        "RemoteCommand bash",
        "Include ~/.ssh/config",
        "Host evil",
        "LocalForward 1234 localhost:22",
        "Match exec whoami",
    ] {
        assert!(validate_options(text, false).is_err(), "{text}");
    }
    assert!(validate_options("ProxyJump relay\nProxyCommand nc %h %p", false).is_err());
    assert!(validate_options("ServerAliveInterval bad", false).is_err());
}

#[test]
fn rendered_config_is_accepted_by_openssh_and_keeps_runtime_controls() {
    let dir = tempfile::tempdir().unwrap();
    let value = serde_json::json!({"hostname":"target.test","port":2222,"ssh_user":"Research.User","key_path":dir.path().join("key with spaces"),"ssh_alias":"target","ssh_options":"ProxyJump relay\nConnectTimeout 15\nServerAliveInterval 30\n","ssh_jump_config":"Host relay\n HostName relay.test\n User jump\n Port 2200\n"});
    let (_, rendered) =
        mossentry::openssh::connection_config(&dir.path().join("known hosts"), &value).unwrap();
    let path = dir.path().join("config");
    fs::write(&path, rendered).unwrap();
    let binary = mossentry::openssh::executable();
    if !binary.is_file() {
        return;
    }
    let result = std::process::Command::new(binary)
        .args(["-G", "-F"])
        .arg(&path)
        .arg("target")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output = String::from_utf8_lossy(&result.stdout);
    for setting in [
        "hostname target.test",
        "user Research.User",
        "port 2222",
        "proxyjump relay",
        "connecttimeout 15",
        "serveraliveinterval 30",
        "batchmode yes",
        "stricthostkeychecking true",
        "clearallforwardings yes",
        "permitlocalcommand no",
    ] {
        assert!(output.contains(setting), "{setting}: {output}");
    }
}

#[test]
fn conditional_includes_cannot_escape_their_host_scope() {
    let dir = tempfile::tempdir().unwrap();
    let child = dir.path().join("child");
    fs::write(
        &child,
        "Port 2200\nHost unreachable\n User ignored\nHost *\n ConnectTimeout 17\n",
    )
    .unwrap();
    let path = dir.path().join("config");
    fs::write(
        &path,
        format!(
            "Host one\n Include {}\n User operator\nHost two\n User other\nHost *\n Port 22\n",
            child.display()
        ),
    )
    .unwrap();
    let parsed = SshConfig::load(&path).unwrap();
    assert_eq!(parsed.aliases, ["one", "two"]);
    assert_eq!(parsed.resolve("one").unwrap()["port"], ["2200"]);
    assert_eq!(parsed.resolve("one").unwrap()["user"], ["operator"]);
    let two = parsed.resolve("two").unwrap();
    assert_eq!(two["port"], ["22"]);
    assert!(!two.contains_key("connecttimeout"));
}
