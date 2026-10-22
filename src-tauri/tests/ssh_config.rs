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
    assert!(!import.servers[0].enabled);
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
