use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Error {
    pub status: u16,
    pub detail: String,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }
    pub fn bad(detail: impl Into<String>) -> Self {
        Self::new(400, detail)
    }
    pub fn remote(detail: impl AsRef<str>) -> Self {
        Self::new(502, friendly(detail.as_ref()))
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        if matches!(&e, rusqlite::Error::SqliteFailure(err, _) if err.extended_code == 2067) {
            Self::new(409, "A server with this name already exists")
        } else {
            eprintln!("Database error: {e}");
            Self::new(500, "Could not read or save local data")
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new(500, format!("Could not access local file: {e}"))
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::bad("Invalid request or saved data")
    }
}
pub fn friendly(raw: &str) -> String {
    let s = raw.to_lowercase();
    let rules: &[(&[&str], &str)] = &[
        (&["bash is not available on this host"], "Bash is not available on this host."),
        (&["protected system or ssh service"], "System or SSH services are protected from changes."),
        (&["systemd is not available"], "This server does not support systemd service management."),
        (&["service is not loaded or is masked"], "The service is unavailable or masked. Check its exact name and configuration."),
        (&["service refuses manual"], "This service refuses manual changes. Check its unit configuration."),
        (&["host key", "identification has changed"], "Verify this server's SSH fingerprint and update the local known hosts file, then retry."),
        (&["no such identity", "private key", "unprotected private"], "Check that the SSH private key exists and only its owner can read it."),
        (&["missing sudo password", "a password is required"], "A sudo password is required. Edit this server to save the SSH login account's sudo password, then retry."),
        (&["incorrect sudo password", "incorrect become password", "sorry, try again"], "The sudo password was rejected. Update it in this server's settings and retry."),
        (&["permission denied", "authentication"], "SSH sign-in failed. Check the login account and private key."),
        (&["sudo", "become", "privilege"], "The management account needs sudo permission. Check its permissions and retry."),
        (&["timed out", "timeout"], "The server did not respond in time. Check its address and network connection."),
        (&["resolve", "name or service"], "The server address could not be found. Check the hostname."),
        (&["refused", "unreachable", "no route"], "Cannot connect to SSH. Check the server, port and network connection."),
        (&["in use", "currently used by process"], "This account has running processes. End its sessions before deleting it."),
    ];
    rules.iter().find(|(keys,_)| keys.iter().any(|k| s.contains(k))).map(|(_,v)| *v)
        .unwrap_or("The operation could not finish. Check the server connection and management permissions, then retry.").into()
}
