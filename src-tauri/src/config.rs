use crate::error::{Error, Result};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub fn setting(name: &str) -> Option<String> {
    std::env::var(format!("MOSSENTRY_{name}"))
        .ok()
        .or_else(|| std::env::var(format!("SRVMGR_{name}")).ok())
}
pub fn expand_path(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    PathBuf::from(value)
}
pub fn permissions(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    permissions(path, 0o700)
}
pub fn private_file(path: &Path, exclusive: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).read(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    permissions(path, 0o600)?;
    Ok(file)
}
pub fn check_private(path: &Path, kind: &str) -> std::result::Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("{kind}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(format!("The {kind} must have mode 600"));
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    Ok(())
}
pub fn database_path(data: &Path) -> PathBuf {
    let current = data.join("mossentry.db");
    let legacy = data.join("server_manager.db");
    if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    }
}
pub fn user_data_directory(app_data: &Path) -> PathBuf {
    if let Some(path) = setting("USER_DATA_DIR") {
        return expand_path(&path);
    }
    for name in [
        "Mossentry",
        "Server Manager",
        "server-manager-desktop",
        "luo-server-manager-desktop",
        "Dry Cactus",
        "Cactus",
    ] {
        let candidate = app_data.join(name);
        if database_path(&candidate.join("data")).exists() {
            return candidate;
        }
    }
    app_data.join("Mossentry")
}
#[derive(Clone)]
pub struct Config {
    pub home: PathBuf,
    pub data: PathBuf,
    pub db: PathBuf,
}
impl Config {
    pub fn discover() -> Result<Self> {
        // Electron used Roaming AppData on Windows and Application Support on macOS.
        #[cfg(target_os = "linux")]
        let base = dirs::config_dir();
        #[cfg(not(target_os = "linux"))]
        let base = dirs::data_dir();
        let home = user_data_directory(
            &base.ok_or_else(|| Error::new(500, "Could not locate application data"))?,
        );
        let data = setting("DATA_DIR")
            .map(|p| expand_path(&p))
            .unwrap_or_else(|| home.join("data"));
        let db = setting("DB_PATH")
            .map(|p| expand_path(&p))
            .unwrap_or_else(|| database_path(&data));
        Ok(Self { home, data, db })
    }
    pub fn isolated(home: PathBuf) -> Self {
        let data = home.join("data");
        let db = database_path(&data);
        Self { home, data, db }
    }
}
