use crate::{
    config,
    db::{n, s},
};
use serde_json::Value;
use ssh2::{CheckResult, KnownHostFileKind, MethodType, Session};
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

pub const ACCOUNTS: &str = include_str!("../remote/remote_actions.py");
pub const RESOURCES: &str = include_str!("../remote/resource_probe.py");
pub const OPERATIONS: &str = include_str!("../remote/operations_probe.py");
pub const FIREWALL: &str = include_str!("../remote/firewall.py");
pub const CREATION: &str = include_str!("../remote/user_creation_times.py");
// Injectable transport keeps regression tests completely disconnected from real hosts.
pub trait Transport: Send + Sync {
    fn execute(
        &self,
        server: &Value,
        source: &str,
        payload: &Value,
        sudo: bool,
        password: Option<&str>,
        timeout: u64,
    ) -> std::result::Result<Value, String>;
}
pub struct NativeSsh {
    known_hosts: std::path::PathBuf,
}
impl Default for NativeSsh {
    fn default() -> Self {
        Self {
            known_hosts: config::expand_path("~/.ssh/known_hosts"),
        }
    }
}
impl NativeSsh {
    pub fn with_known_hosts(path: std::path::PathBuf) -> Self {
        Self { known_hosts: path }
    }
}
pub fn framed_program(source: &str, marker: &str) -> String {
    // JSON string literals are valid Python string literals, including Unicode escapes.
    format!("import sys\nfor _line in sys.stdin:\n    if _line.rstrip('\\r\\n') == {}:\n        break\nelse:\n    raise RuntimeError('Missing SSH request marker')\nexec(compile({}, '<mossentry>', 'exec'))\n",serde_json::to_string(marker).unwrap(),serde_json::to_string(source).unwrap())
}
pub fn redact(raw: &str, password: Option<&str>) -> String {
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        let escaped = serde_json::to_string(p).unwrap();
        raw.replace(p, "[redacted]")
            .replace(&escaped[1..escaped.len() - 1], "[redacted]")
    } else {
        raw.to_owned()
    }
}
impl Transport for NativeSsh {
    fn execute(
        &self,
        server: &Value,
        source: &str,
        payload: &Value,
        sudo: bool,
        password: Option<&str>,
        timeout: u64,
    ) -> std::result::Result<Value, String> {
        let result = if s(server, "ssh_backend") == "openssh" {
            crate::openssh::execute(
                &self.known_hosts,
                server,
                source,
                payload,
                sudo,
                password,
                timeout,
            )
        } else {
            execute(
                &self.known_hosts,
                server,
                source,
                payload,
                sudo,
                password,
                timeout,
            )
        };
        result.map_err(|e| redact(&e, password))
    }
}
fn execute(
    known: &std::path::Path,
    server: &Value,
    source: &str,
    payload: &Value,
    sudo: bool,
    password: Option<&str>,
    timeout: u64,
) -> std::result::Result<Value, String> {
    let attempt = || -> std::result::Result<Value, Box<dyn std::error::Error>> {
        let key = config::expand_path(s(server, "key_path"));
        config::check_private(&key, "SSH private key")?;
        let host = s(server, "hostname");
        let port = n(server, "port") as u16;
        let addresses = (host, port).to_socket_addrs()?;
        let mut socket = None;
        let mut last_error = "Cannot resolve server address".to_owned();
        for address in addresses {
            match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
                Ok(s) => {
                    socket = Some(s);
                    break;
                }
                Err(e) => last_error = e.to_string(),
            }
        }
        let stream = socket.ok_or(last_error)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        let mut session = Session::new()?;
        session.set_tcp_stream(stream);
        session.set_timeout(10_000);
        let mut hosts = session.known_hosts()?;
        if !known.exists() {
            return Err("Host key verification failed: known_hosts is missing".into());
        }
        hosts
            .read_file(known, KnownHostFileKind::OpenSSH)
            .map_err(|_| "Host key verification failed: cannot read known_hosts")?;
        // Negotiate a key type already trusted for this host, including hashed
        // known_hosts entries. Otherwise libssh2 may choose a different valid
        // server key and reject an existing OpenSSH/Paramiko configuration.
        let mut trusted_algorithms = std::collections::HashSet::new();
        for entry in hosts.hosts()? {
            let line = hosts.write_string(&entry, KnownHostFileKind::OpenSSH)?;
            let public = line
                .split_whitespace()
                .skip(1)
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            if let Ok(key) = ssh_key::PublicKey::from_openssh(&public) {
                if matches!(
                    hosts.check_port(host, port, &key.to_bytes()?),
                    CheckResult::Match
                ) {
                    trusted_algorithms.insert(key.algorithm().to_string());
                }
            }
        }
        let algorithms = session
            .supported_algs(MethodType::HostKey)?
            .into_iter()
            .filter(|algorithm| {
                trusted_algorithms.contains(*algorithm)
                    || (matches!(*algorithm, "rsa-sha2-256" | "rsa-sha2-512")
                        && trusted_algorithms.contains("ssh-rsa"))
            })
            .collect::<Vec<_>>()
            .join(",");
        if algorithms.is_empty() {
            return Err(
                "Host key verification failed: no supported trusted key for this host".into(),
            );
        }
        session.method_pref(MethodType::HostKey, &algorithms)?;
        session.handshake()?;
        let (host_key, _) = session.host_key().ok_or("Host key verification failed")?;
        if !matches!(hosts.check_port(host, port, host_key), CheckResult::Match) {
            return Err("Host key verification failed".into());
        }
        session
            .userauth_pubkey_file(s(server, "ssh_user"), None, &key, None)
            .map_err(|e| format!("SSH authentication failed: {e}"))?;
        if !session.authenticated() {
            return Err("SSH authentication failed".into());
        }
        session.set_keepalive(true, 5);
        let marker = format!("mossentry-request-{:032x}", rand::random::<u128>());
        let program = framed_program(source, &marker);
        // The login shell expands the SSH tuple before sudo clears its environment.
        let command = format!(
            "{}/usr/bin/python3 -c {} \"$SSH_CONNECTION\"",
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
        let mut channel = session.channel_session()?;
        channel.exec(&command)?;
        if sudo {
            if let Some(p) = password {
                channel.write_all(format!("{p}\n").as_bytes())?;
            }
        }
        channel.write_all(format!("{marker}\n{payload}\n").as_bytes())?;
        channel.send_eof()?;
        session.set_blocking(false);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let (mut output, mut errors) = (Vec::new(), Vec::new());
        loop {
            let mut progress = false;
            for (mut stream, buffer) in [
                (channel.stream(0), &mut output),
                (channel.stderr(), &mut errors),
            ] {
                let mut chunk = [0u8; 65536];
                match stream.read(&mut chunk) {
                    Ok(count) => {
                        if count > 0 {
                            buffer.extend_from_slice(&chunk[..count]);
                            progress = true;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e.into()),
                }
            }
            if output.len() + errors.len() > 16 * 1024 * 1024 {
                return Err("SSH response exceeded the size limit".into());
            }
            if channel.eof() && !progress {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!("SSH operation timed out after {timeout} seconds").into());
            }
            let _ = session.keepalive_send();
            if !progress {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        session.set_blocking(true);
        channel.wait_close()?;
        if channel.exit_status()? != 0 {
            let message =
                String::from_utf8_lossy(if errors.is_empty() { &output } else { &errors });
            return Err(if message.is_empty() {
                "Remote operation failed".into()
            } else {
                message
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
                    .into()
            });
        }
        Ok(serde_json::from_slice(&output)?)
    };
    attempt().map_err(|e| e.to_string())
}
