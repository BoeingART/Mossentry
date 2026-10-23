use crate::{
    db::{self, s},
    error::{Error, Result},
    service::Service,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn ping_command(host: &str) -> Command {
    let ipv6 = host.parse::<std::net::Ipv6Addr>().is_ok();
    let mut command = Command::new(if cfg!(target_os = "macos") && ipv6 {
        "ping6"
    } else {
        "ping"
    });
    if cfg!(windows) {
        command.args(["-n", "4", "-w", "1000"]);
    } else {
        command.args(["-n", "-c", "4", "-W"]);
        command.arg(if cfg!(target_os = "macos") {
            "1000"
        } else {
            "1"
        });
    }
    if ipv6 && !cfg!(target_os = "macos") {
        command.arg("-6");
    }
    command.arg(host);
    command
}

fn execute_ping(mut command: Command, timeout: Duration) -> Result<Value> {
    let mut output = tempfile::tempfile()?;
    command
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output.try_clone()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| {
        Error::bad("Could not start ping. Check that the system ping tool is installed.")
    })?;
    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status, false),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            result => {
                let _ = child.kill();
                let status = child.wait()?;
                if let Err(error) = result {
                    return Err(error.into());
                }
                break (status, true);
            }
        }
    };
    output.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    output.take(64 * 1024).read_to_end(&mut bytes)?;
    Ok(
        json!({"ok":status.success() && !timed_out,"exit_code":status.code(),"timed_out":timed_out,"output":String::from_utf8_lossy(&bytes)}),
    )
}

impl Service {
    pub fn ping(&self, server: &Value) -> Result<Value> {
        // Probe the configured destination from this computer, independently of SSH.
        let mut value = execute_ping(ping_command(s(server, "hostname")), Duration::from_secs(12))?;
        value["hostname"] = server["hostname"].clone();
        value["checked_at"] = json!(db::now());
        db::audit(
            &self.connection()?,
            "ping_tested",
            Some(s(server, "name")),
            json!({"ok":value["ok"]}),
        )?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ping_uses_bounded_count_and_a_literal_destination() {
        let command = ping_command("2001:db8::1");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(args.last().unwrap(), "2001:db8::1");
        assert!(args.contains(&"4".into()));
        assert!(!args.iter().any(|arg| arg.contains("sh")));
    }
    #[cfg(unix)]
    #[test]
    fn ping_reports_failure_and_times_out_without_waiting_for_the_probe() {
        let mut failed = Command::new("/bin/sh");
        failed.args(["-c", "printf 'no reply'; exit 1"]);
        let result = execute_ping(failed, Duration::from_secs(1)).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["exit_code"], 1);
        assert_eq!(result["output"], "no reply");
        let mut slow = Command::new("/bin/sh");
        slow.args(["-c", "exec sleep 5"]);
        let started = Instant::now();
        let result = execute_ping(slow, Duration::from_millis(20)).unwrap();
        assert_eq!(result["timed_out"], true);
        assert_eq!(result["ok"], false);
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut success = Command::new("/bin/sh");
        success.args(["-c", "printf 'reply'"]);
        assert_eq!(
            execute_ping(success, Duration::from_secs(1)).unwrap()["ok"],
            true
        );
    }
}
