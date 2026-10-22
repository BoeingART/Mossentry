use crate::{
    config::expand_path,
    error::{Error, Result},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
fn yes() -> bool {
    true
}
fn port() -> u16 {
    22
}
fn key() -> String {
    expand_path("~/.ssh/id_rsa").to_string_lossy().into_owned()
}
pub fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).expect("fixed regex").is_match(value)
}
pub fn username(value: &str) -> Result<()> {
    if matches(r"^[a-z_][a-z0-9_-]{0,31}$", value) {
        Ok(())
    } else {
        Err(Error::bad("Invalid username"))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerInput {
    pub name: String,
    pub hostname: String,
    #[serde(default = "port")]
    pub port: u16,
    pub ssh_user: String,
    #[serde(default = "key")]
    pub key_path: String,
    #[serde(default = "yes", deserialize_with = "bool_or_int")]
    pub enabled: bool,
    #[serde(default)]
    pub sudo_password: Option<String>,
    #[serde(default)]
    pub clear_sudo_password: bool,
    #[serde(default)]
    pub group_name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "native_backend")]
    pub ssh_backend: String,
    #[serde(default)]
    pub ssh_alias: String,
    #[serde(default)]
    pub ssh_options: String,
    #[serde(default)]
    pub ssh_jump_config: String,
}
fn native_backend() -> String {
    "native".into()
}
fn bool_or_int<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    match Value::deserialize(d)? {
        Value::Bool(v) => Ok(v),
        Value::Number(v) if v == 0.into() => Ok(false),
        Value::Number(v) if v == 1.into() => Ok(true),
        _ => Err(serde::de::Error::custom("Invalid enabled value")),
    }
}
impl ServerInput {
    pub fn parse(v: Value) -> Result<Self> {
        let mut s: Self = serde_json::from_value(v)
            .map_err(|_| Error::new(422, "Check the server settings and try again."))?;
        s.hostname = s.hostname.trim().into();
        if !matches(r"^[a-z][a-z0-9_-]{0,31}$", &s.name) {
            return Err(Error::bad("Check the server name and try again."));
        }
        if ["all", "ungrouped", "managed"].contains(&s.name.as_str()) {
            return Err(Error::bad("This server name is reserved"));
        }
        if !matches(r"^[A-Za-z0-9_][A-Za-z0-9_.@\\$-]{0,127}$", &s.ssh_user) {
            return Err(Error::bad("Invalid SSH login account"));
        }
        if !["native", "openssh"].contains(&s.ssh_backend.as_str()) {
            return Err(Error::bad("Invalid SSH transport"));
        }
        if !s.ssh_alias.is_empty() && !matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", &s.ssh_alias)
        {
            return Err(Error::bad("Invalid SSH Host alias"));
        }
        crate::ssh_config::validate_options(&s.ssh_options, false)?;
        crate::ssh_config::validate_options(&s.ssh_jump_config, true)?;
        if s.ssh_backend == "native"
            && (!s.ssh_options.trim().is_empty() || !s.ssh_jump_config.trim().is_empty())
        {
            return Err(Error::bad(
                "Select OpenSSH to use advanced SSH login settings",
            ));
        }
        let host_valid = s.hostname.parse::<std::net::IpAddr>().is_ok()
            || s.hostname
                .trim_end_matches('.')
                .split('.')
                .all(|label| matches(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", label));
        if !host_valid || s.hostname.len() > 253 {
            return Err(Error::bad(
                "Enter a hostname or IP address without a protocol or port",
            ));
        }
        if s.port == 0 {
            return Err(Error::bad("Check the SSH port and try again."));
        }
        if s.key_path.chars().any(|c| c < ' ') || s.key_path.len() > 1024 {
            return Err(Error::bad("Invalid SSH key path"));
        }
        let p = expand_path(s.key_path.trim());
        if !p.is_absolute() && !(s.key_path.trim().is_empty() && s.ssh_backend == "openssh") {
            return Err(Error::bad(
                "Use an absolute SSH key path or a path starting with ~/",
            ));
        }
        s.key_path = if s.key_path.trim().is_empty() {
            String::new()
        } else {
            p.to_string_lossy().into_owned()
        };
        if s.sudo_password
            .as_ref()
            .is_some_and(|s| s.chars().count() > 4096 || s.contains(['\r', '\n', '\0']))
        {
            return Err(Error::bad(
                "Enter a sudo password of at most 4096 characters without line breaks",
            ));
        }
        if s.group_name.chars().count() > 80 || s.notes.chars().count() > 2000 {
            return Err(Error::bad("Check the entered information and try again."));
        }
        Ok(s)
    }
}
fn timeout() -> u64 {
    300
}
fn minutes() -> u32 {
    60
}
fn lines() -> u32 {
    100
}
fn priority() -> u8 {
    6
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Operation {
    pub servers: Vec<String>,
    pub operation: String,
    #[serde(default)]
    pub command: String,
    #[serde(default = "timeout")]
    pub timeout: u64,
    #[serde(default)]
    pub risk_acknowledged: bool,
    #[serde(default)]
    pub unit: String,
    #[serde(default = "minutes")]
    pub minutes: u32,
    #[serde(default = "lines")]
    pub lines: u32,
    #[serde(default = "priority")]
    pub priority: u8,
    #[serde(default)]
    pub elevated: bool,
    #[serde(default)]
    pub confirmation: String,
}
impl Operation {
    pub fn parse(v: Value) -> Result<Self> {
        let mut s: Self = serde_json::from_value(v)
            .map_err(|_| Error::new(422, "Check the operation settings and try again."))?;
        if ![
            "inspect", "services", "logs", "start", "stop", "restart", "enable", "disable",
            "dry_run", "command",
        ]
        .contains(&s.operation.as_str())
        {
            return Err(Error::bad("Unknown operation"));
        }
        if s.command.contains('\0') {
            return Err(Error::bad("Commands cannot contain NUL characters"));
        }
        s.command = s.command.replace("\r\n", "\n");
        if s.command.chars().count() > 32768
            || !(10..=3600).contains(&s.timeout)
            || !(1..=10080).contains(&s.minutes)
            || !(1..=1000).contains(&s.lines)
            || s.priority > 7
        {
            return Err(Error::bad("Check the operation settings and try again."));
        }
        if !s.unit.is_empty()
            && !matches(r"^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,191}\.service$", &s.unit)
        {
            return Err(Error::bad("Enter an exact service name ending in .service"));
        }
        Ok(s)
    }
    pub fn payload(&self) -> Value {
        let mut p = serde_json::to_value(self).expect("serializable operation");
        for k in ["servers", "confirmation", "risk_acknowledged"] {
            p.as_object_mut().unwrap().remove(k);
        }
        p
    }
}
pub fn server_names(v: &Value) -> Result<Vec<String>> {
    let names: Vec<String> = serde_json::from_value(v.clone())
        .map_err(|_| Error::bad("The selection includes an unknown or disabled host"))?;
    let mut unique = Vec::new();
    for n in names {
        if !unique.contains(&n) {
            unique.push(n);
        }
    }
    if unique.is_empty() {
        return Err(Error::bad(
            "The selection includes an unknown or disabled host",
        ));
    }
    Ok(unique)
}
