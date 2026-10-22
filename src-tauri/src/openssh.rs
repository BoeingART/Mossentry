use crate::{
    config,
    db::{n, s},
    ssh, ssh_config,
};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
pub fn executable() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/OpenSSH/ssh.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/usr/bin/ssh")
    }
}

pub fn connection_config(
    known: &Path,
    server: &Value,
) -> std::result::Result<(String, String), String> {
    let alias = if s(server, "ssh_alias").is_empty() {
        "mossentry-target"
    } else {
        s(server, "ssh_alias")
    };
    if !crate::model::matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", alias) {
        return Err("Invalid SSH Host alias".into());
    }
    ssh_config::validate_options(s(server, "ssh_options"), false).map_err(|e| e.detail)?;
    ssh_config::validate_options(s(server, "ssh_jump_config"), true).map_err(|e| e.detail)?;
    // Only login settings are admitted. Jobs always execute their own command,
    // without interactive sessions, local hooks, forwarding or shared masters.
    let mut text = format!(
        "IgnoreUnknown UseKeychain\nHost {alias}\n  HostName {}\n  User {}\n  Port {}\n",
        ssh_config::quote(s(server, "hostname")),
        ssh_config::quote(s(server, "ssh_user")),
        n(server, "port")
    );
    if !s(server, "key_path").is_empty() {
        text.push_str(&format!(
            "  IdentityFile {}\n",
            ssh_config::quote(s(server, "key_path"))
        ));
    }
    text.push_str(s(server, "ssh_options"));
    text.push('\n');
    text.push_str(s(server, "ssh_jump_config"));
    text.push_str(&format!("\nHost *\n  BatchMode yes\n  NumberOfPasswordPrompts 0\n  StrictHostKeyChecking yes\n  UserKnownHostsFile {}\n  ConnectTimeout 10\n  ConnectionAttempts 1\n  ServerAliveInterval 5\n  ServerAliveCountMax 3\n  RequestTTY no\n  PermitLocalCommand no\n  ClearAllForwardings yes\n  ControlMaster no\n  ControlPath none\n  ForkAfterAuthentication no\n  UpdateHostKeys no\n", ssh_config::quote(&known.to_string_lossy())));
    Ok((alias.to_owned(), text))
}

fn output(mut pipe: impl Read, total: Arc<AtomicUsize>) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 16384];
    loop {
        let count = pipe.read(&mut buffer)?;
        if count == 0 {
            return Ok(result);
        }
        if total.fetch_add(count, Ordering::Relaxed) + count > OUTPUT_LIMIT {
            return Err(std::io::Error::other(
                "SSH response exceeded the size limit",
            ));
        }
        result.extend_from_slice(&buffer[..count]);
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    // The child owns a separate process group, including ProxyJump processes.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system =
            PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
        let _ = Command::new(system.join("System32/taskkill.exe"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn execute(
    known: &Path,
    server: &Value,
    source: &str,
    payload: &Value,
    sudo: bool,
    password: Option<&str>,
    timeout: u64,
) -> std::result::Result<Value, String> {
    let attempt = || -> std::result::Result<Value, Box<dyn std::error::Error>> {
        let executable = executable();
        if !executable.is_file() {
            return Err("OpenSSH client is unavailable. Install the Windows OpenSSH Client optional feature or select the built-in SSH transport.".into());
        }
        let (alias, text) = connection_config(known, server)?;
        let temporary = tempfile::tempdir()?;
        config::permissions(temporary.path(), 0o700)?;
        let path = temporary.path().join("config");
        {
            let mut file = config::private_file(&path, true)?;
            file.write_all(text.as_bytes())?;
        }
        let marker = format!("mossentry-request-{:032x}", rand::random::<u128>());
        let program = ssh::framed_program(source, &marker);
        let command = format!(
            "{}/usr/bin/python3 -c {}",
            if sudo {
                if password.is_some() {
                    "sudo -S -p '' -- "
                } else {
                    "sudo -n -- "
                }
            } else {
                ""
            },
            shell_words::quote(&program)
        );
        let mut input = Vec::new();
        if sudo {
            if let Some(password) = password {
                writeln!(input, "{password}")?;
            }
        }
        writeln!(input, "{marker}\n{payload}")?;
        let mut process = Command::new(executable);
        process
            .args(["-T", "-F"])
            .arg(&path)
            .arg("--")
            .arg(alias)
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("SSH_ASKPASS_REQUIRE", "never");
        if let Some(home) = dirs::home_dir() {
            process.current_dir(home);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x08000000);
        }
        let mut child = process.spawn()?;
        let mut stdin = child.stdin.take().ok_or("SSH input unavailable")?;
        let stdout = child.stdout.take().ok_or("SSH output unavailable")?;
        let stderr = child.stderr.take().ok_or("SSH diagnostics unavailable")?;
        let writer = thread::spawn(move || stdin.write_all(&input));
        let total = Arc::new(AtomicUsize::new(0));
        let out_total = total.clone();
        let err_total = total.clone();
        let out_reader = thread::spawn(move || output(stdout, out_total));
        let err_reader = thread::spawn(move || output(stderr, err_total));
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let status = loop {
            if total.load(Ordering::Relaxed) > OUTPUT_LIMIT {
                terminate(&mut child);
                break Err("SSH response exceeded the size limit".to_owned());
            }
            if Instant::now() >= deadline {
                terminate(&mut child);
                break Err(format!("SSH operation timed out after {timeout} seconds"));
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    terminate(&mut child);
                    break Err(error.to_string());
                }
            }
        };
        // A proxy may retain inherited pipes after ssh exits. End its process
        // group before joining readers so timeout and failure stay bounded.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let written = writer
            .join()
            .map_err(|_| "SSH input stopped unexpectedly")?;
        let out = out_reader
            .join()
            .map_err(|_| "SSH output stopped unexpectedly")?;
        let err = err_reader
            .join()
            .map_err(|_| "SSH diagnostics stopped unexpectedly")?;
        let status = status?;
        let out = out?;
        let err = err?;
        if !status.success() {
            let message = String::from_utf8_lossy(if err.is_empty() { &out } else { &err });
            return Err(format!(
                "OpenSSH connection failed: {}",
                message
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            )
            .into());
        }
        written?;
        fs::remove_file(path)?;
        Ok(serde_json::from_slice(&out)?)
    };
    attempt().map_err(|e| ssh::redact(&e.to_string(), password))
}
