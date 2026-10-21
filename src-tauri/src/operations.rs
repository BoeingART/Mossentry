use crate::{
    db::{self, n, s},
    error::{Error, Result},
    model::Operation,
    service::{OperationGuard, Service},
    ssh,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    sync::Arc,
};
pub const INTERRUPTED: &str =
    "The app stopped before a result was recorded. Check the server before retrying.";
pub const MUTATIONS: &[&str] = &["start", "stop", "restart", "enable", "disable"];
pub fn risks(script: &str, elevated: bool) -> Vec<String> {
    risks_at_depth(script, elevated, 0)
}
fn risk_tokens(script: &str) -> Vec<String> {
    let mut spaced = String::new();
    let (mut single, mut double, mut escaped) = (false, false, false);
    for c in script.chars() {
        if escaped {
            spaced.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && !single {
            spaced.push(c);
            escaped = true;
            continue;
        }
        if c == '\'' && !double {
            single = !single;
        }
        if c == '"' && !single {
            double = !double;
        }
        if !single && !double && "();<>|&".contains(c) {
            spaced.push(' ');
            spaced.push(c);
            spaced.push(' ');
        } else {
            spaced.push(c);
        }
    }
    shell_words::split(&spaced)
        .unwrap_or_else(|_| script.split_whitespace().map(str::to_owned).collect())
}
fn risks_at_depth(script: &str, elevated: bool, depth: usize) -> Vec<String> {
    let rules:[(&str,&str);10]=[
        ("rm rmdir unlink shred userdel deluser groupdel","Deletion commands may permanently remove files or accounts."),
        ("chmod chown chgrp setfacl setcap umask usermod passwd chattr visudo","Permission or ownership changes may expose data or lock users out."),
        ("sudo su doas","Elevated privileges can change system files and affect all users."),
        ("apt apt-get dpkg yum dnf rpm pacman zypper apk snap pip pip3","Package changes may install, remove or upgrade software and restart services."),
        ("systemctl service kill pkill killall","Service or process changes may interrupt running workloads or SSH access."),
        ("reboot shutdown poweroff halt init telinit","Shutdown or reboot commands may disconnect the server."),
        ("dd fdisk sfdisk parted wipefs mount umount mkswap lvremove vgremove pvremove","Disk or filesystem commands may overwrite data or make storage unavailable."),
        ("iptables ip6tables nft ufw firewall-cmd ip ifconfig nmcli netplan","Network or firewall changes may disconnect SSH access."),
        ("tee truncate cp mv install touch","File writes or redirections may overwrite existing data."),
        ("eval exec source . bash sh dash zsh python python3 perl ruby node curl wget xargs ssh","Dynamic commands, scripts or downloaded code cannot be fully checked before execution.")];
    let owned_tokens = risk_tokens(script);
    let tokens: Vec<&str> = owned_tokens.iter().map(String::as_str).collect();
    let words: HashSet<&str> = tokens
        .iter()
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .collect();
    let mut found: Vec<bool> = rules
        .iter()
        .map(|(commands, _)| commands.split_whitespace().any(|w| words.contains(w)))
        .collect();
    found[0] |= words.contains("find") && tokens.contains(&"-delete")
        || words.contains("rsync") && tokens.iter().any(|t| t.starts_with("--delete"));
    found[2] |= elevated;
    found[6] |= words
        .iter()
        .any(|w| w.starts_with("mkfs") || w.starts_with("fsck"));
    found[8] |=
        script.contains('>') || words.contains("sed") && tokens.iter().any(|t| t.starts_with("-i"));
    found[9] |= script.contains(['$', '`'])
        || words.iter().any(|w| w.ends_with(".sh"))
        || words.contains("find") && (tokens.contains(&"-exec") || tokens.contains(&"-execdir"));
    if found[9] && depth < 3 {
        for token in &tokens {
            if token.chars().any(char::is_whitespace) {
                let nested = risks_at_depth(token, false, depth + 1);
                for (i, (_, message)) in rules.iter().enumerate() {
                    found[i] |= nested.iter().any(|v| v == message);
                }
            }
        }
    }
    rules
        .iter()
        .enumerate()
        .filter(|(i, _)| found[*i])
        .map(|(_, (_, m))| m.to_string())
        .collect()
}
pub fn protected_unit(unit: &str) -> bool {
    let base = unit
        .trim_end_matches(".service")
        .split('@')
        .next()
        .unwrap_or(unit)
        .to_lowercase();
    [
        "ssh",
        "sshd",
        "network",
        "networking",
        "networkmanager",
        "dbus",
        "systemd-networkd",
        "systemd-resolved",
        "systemd-logind",
        "systemd-journald",
        "systemd-udevd",
        "firewalld",
        "ufw",
    ]
    .contains(&base.as_str())
}
pub fn validate(body: &Operation) -> Result<()> {
    let op = body.operation.as_str();
    if ["command", "dry_run"].contains(&op) {
        if body.command.trim().is_empty() {
            return Err(Error::bad("Enter a Linux command (up to 32768 characters)"));
        }
        if op == "command"
            && !body.risk_acknowledged
            && !risks(&body.command, body.elevated).is_empty()
        {
            return Err(Error::bad(
                "Acknowledge the command warnings before execution.",
            ));
        }
    } else if MUTATIONS.contains(&op) {
        if body.unit.is_empty() || body.confirmation != format!("{op} {}", body.unit) {
            return Err(Error::bad("Type the operation and service name to confirm"));
        }
        if protected_unit(&body.unit) {
            return Err(Error::bad("Protected system or SSH service"));
        }
    } else if body.elevated && op != "logs" {
        return Err(Error::bad(
            "Elevated access is only available for service changes and log queries",
        ));
    }
    Ok(())
}
pub fn analyze(mut result: Value) -> Value {
    let rules: [(&str, &str, &str); 8] = [
        (
            "shell",
            "A shell or package script reported an error.",
            r":\s*(?:Illegal number|integer expression expected|syntax error|unbound variable|bad substitution|command not found)\b",
        ),
        (
            "service",
            "A service operation reported a problem.",
            r"(?:^|:\s*)(?:Could not execute systemctl\b|(?:Failed|Unable) to (?:start|stop|restart|reload|enable|disable)\b)",
        ),
        (
            "configuration",
            "Package configuration reported a problem or used a fallback.",
            r"^(?:debconf|dpkg-preconfigure):\s*(?:unable to|falling back to)\b",
        ),
        (
            "packages",
            "The package manager reported a problem.",
            r"^(?:E:\s*|dpkg:\s*(?:error|warning):|.*\bpackages have unmet dependencies:)",
        ),
        (
            "access",
            "The command reported an access or storage problem.",
            r":\s*(?:Permission denied|Operation not permitted|No space left on device|Read-only file system)\b",
        ),
        (
            "exception",
            "The command reported an exception.",
            r"^Traceback \(most recent call last\):",
        ),
        (
            "error",
            "The command reported an error.",
            r"^(?:[\w./-]+(?:\[\d+\])?:\s*)?(?:error|fatal|critical)\s*:",
        ),
        (
            "warning",
            "The command reported a warning.",
            r"^(?:[\w./-]+(?:\[\d+\])?:\s*)?(?:warning|warn)\s*:",
        ),
    ];
    let compiled: Vec<_> = rules
        .iter()
        .map(|(_, _, r)| {
            regex::RegexBuilder::new(r)
                .case_insensitive(true)
                .build()
                .unwrap()
        })
        .collect();
    let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
    let mut diagnostics: Vec<Value> = Vec::new();
    for stream in ["stdout", "stderr"] {
        for (i, line) in s(&result, stream).lines().enumerate() {
            let plain = ansi.replace_all(line, "");
            if let Some(rule) = compiled.iter().position(|r| r.is_match(plain.trim())) {
                let (code, summary, _) = rules[rule];
                let index=diagnostics.iter().position(|d|s(d,"stream")==stream&&s(d,"code")==code).unwrap_or_else(||{diagnostics.push(json!({"code":code,"summary":summary,"stream":stream,"count":0,"matches":[]}));diagnostics.len()-1});
                let item = &mut diagnostics[index];
                item["count"] = json!(n(item, "count") + 1);
                let matches = item["matches"].as_array_mut().unwrap();
                if matches.len() < 5 {
                    matches.push(json!({"line":i+1,"text":line.chars().take(2000).collect::<String>(),"truncated":line.chars().count()>2000}));
                }
            }
        }
    }
    result["output_diagnostics"] = json!(diagnostics);
    result["output_diagnostics_version"] = json!(1);
    result
}
pub fn result_status(result: &Value) -> &'static str {
    if result
        .get("exit_code")
        .is_some_and(|v| v.as_i64() != Some(0))
        || result["timed_out"] == true
        || result["syntax_ok"] == false
    {
        "failed"
    } else if result["output_diagnostics"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        "completed_with_warnings"
    } else {
        "completed"
    }
}
pub fn job_status(states: &[String]) -> &'static str {
    if !states.is_empty()
        && states
            .iter()
            .all(|s| s == "completed" || s == "completed_with_warnings")
    {
        if states.iter().any(|s| s == "completed_with_warnings") {
            "completed_with_warnings"
        } else {
            "completed"
        }
    } else if !states.is_empty() && states.iter().all(|s| s == "failed") {
        "failed"
    } else {
        "partial"
    }
}
pub fn backfill(c: &Connection) -> Result<()> {
    if db::row(
        c,
        "SELECT 1 FROM settings WHERE key='operation_output_diagnostics_version' AND value='1'",
        [],
    )?
    .is_some()
    {
        return Ok(());
    }
    let mut changed = BTreeSet::new();
    for r in db::rows(c,"SELECT r.* FROM operation_results r JOIN operation_jobs j ON j.id=r.job_id WHERE j.operation='command' AND j.status IN ('completed','completed_with_warnings','failed','partial') AND r.status IN ('completed','completed_with_warnings','failed') AND r.result_json IS NOT NULL",[])? {
        let result:Value=serde_json::from_str(s(&r,"result_json"))?;
        if !result.is_object(){continue;}
        let result=analyze(result);
        let status=if s(&r,"status")=="failed"||!r["error"].is_null(){"failed"}else{result_status(&result)};
        c.execute("UPDATE operation_results SET status=?,result_json=? WHERE job_id=? AND server_name=?",params![status,result.to_string(),n(&r,"job_id"),s(&r,"server_name")])?;
        changed.insert(n(&r,"job_id"));
    }
    for id in changed {
        finish(c, id)?;
    }
    c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('operation_output_diagnostics_version','1')",[])?;
    Ok(())
}
fn finish(c: &Connection, id: i64) -> Result<()> {
    let states: Vec<String> = db::rows(
        c,
        "SELECT status FROM operation_results WHERE job_id=?",
        [id],
    )?
    .iter()
    .map(|v| s(v, "status").into())
    .collect();
    c.execute(
        "UPDATE operation_jobs SET status=? WHERE id=?",
        params![job_status(&states), id],
    )?;
    Ok(())
}
pub fn detail(c: &Connection, id: i64) -> Result<Value> {
    let mut job = db::row(c, "SELECT * FROM operation_jobs WHERE id=?", [id])?
        .ok_or_else(|| Error::new(404, "Operation no longer exists"))?;
    job["payload"] = serde_json::from_str(s(&job, "payload_json"))?;
    job.as_object_mut().unwrap().remove("payload_json");
    let mut results = db::rows(
        c,
        "SELECT * FROM operation_results WHERE job_id=? ORDER BY server_name",
        [id],
    )?;
    for r in &mut results {
        r["result"] = serde_json::from_str(r["result_json"].as_str().unwrap_or("null"))?;
        r.as_object_mut().unwrap().remove("result_json");
    }
    job["results"] = json!(results);
    Ok(job)
}
pub fn start(service: Arc<Service>, body: Operation, guard: OperationGuard) -> Result<Value> {
    let mut c = service.connection()?;
    let names = service.validate_servers(&body.servers)?;
    validate(&body)?;
    let payload = body.payload();
    let tx = c.transaction()?;
    db::audit(
        &tx,
        "operation_started",
        Some(&names.join(",")),
        json!({"operation":body.operation,"unit":body.unit}),
    )?;
    tx.execute("INSERT INTO operation_jobs(operation,payload_json,status,requested_by,created_at) VALUES(?,?,'running',(SELECT id FROM admins WHERE active=1 ORDER BY id LIMIT 1),?)",params![body.operation,payload.to_string(),db::now()])?;
    let id = tx.last_insert_rowid();
    for name in &names {
        tx.execute(
            "INSERT INTO operation_results(job_id,server_name,status) VALUES(?,?,'queued')",
            params![id, name],
        )?;
    }
    tx.commit()?;
    let failure_service = service.clone();
    let worker = std::thread::Builder::new()
        .name(format!("mossentry-operation-{id}"))
        .spawn(move || {
            let _guard = guard;
            if run_job(&service, id, &names, &payload).is_err() {
                let _ = interrupt(&service, id);
            }
        });
    if worker.is_err() {
        interrupt(&failure_service, id)?;
        return Err(Error::new(500, "Could not start local worker"));
    }
    Ok(json!({"id":id}))
}
fn interrupt(service: &Service, id: i64) -> Result<()> {
    let mut c = service.connection()?;
    let tx = c.transaction()?;
    tx.execute("UPDATE operation_results SET status='interrupted',error=?,finished_at=? WHERE job_id=? AND status IN ('queued','running')",params![INTERRUPTED,db::now(),id])?;
    tx.execute(
        "UPDATE operation_jobs SET status='interrupted',finished_at=? WHERE id=?",
        params![db::now(), id],
    )?;
    tx.commit()?;
    Ok(())
}
fn run_job(service: &Service, id: i64, names: &[String], payload: &Value) -> Result<()> {
    let c = service.connection()?;
    for name in names {
        c.execute("UPDATE operation_results SET status='running',started_at=? WHERE job_id=? AND server_name=?",params![db::now(),id,name])?;
        let run = || -> Result<Value> {
            let server = service.server_by_name(name)?;
            let op = s(payload, "operation");
            let sudo = op != "dry_run" && (MUTATIONS.contains(&op) || payload["elevated"] == true);
            let timeout = if op == "command" {
                payload["timeout"].as_u64().unwrap_or(300) + 30
            } else {
                100
            };
            let mut value = service
                .remote(&server, ssh::OPERATIONS, payload, sudo, timeout)
                .map_err(Error::remote)?;
            if !value.is_object()
                || value.get("checked_at").is_none()
                || value.to_string().len() > 4 * 1024 * 1024
            {
                return Err(Error::remote("Invalid operation response"));
            }
            if !value["error"].is_null() && !s(&value, "error").is_empty() {
                return Err(Error::remote(s(&value, "error")));
            }
            if op == "command" {
                value = analyze(value);
            }
            Ok(value)
        };
        match run() {
            Ok(value) => {
                c.execute("UPDATE operation_results SET status=?,result_json=?,finished_at=? WHERE job_id=? AND server_name=?",params![result_status(&value),value.to_string(),db::now(),id,name])?;
            }
            Err(e) => {
                c.execute("UPDATE operation_results SET status='failed',error=?,finished_at=? WHERE job_id=? AND server_name=?",params![e.detail,db::now(),id,name])?;
            }
        }
        db::audit(
            &c,
            "operation_host_finished",
            Some(name),
            json!({"job_id":id,"operation":payload["operation"]}),
        )?;
    }
    finish(&c, id)?;
    c.execute(
        "UPDATE operation_jobs SET finished_at=? WHERE id=?",
        params![db::now(), id],
    )?;
    Ok(())
}
