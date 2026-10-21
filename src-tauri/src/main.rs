#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|arg| arg == "--smoke-test") {
        if let Err(error) = smoke_test() {
            eprintln!("Mossentry smoke test failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(feature = "desktop")]
    mossentry::desktop::run();
    #[cfg(not(feature = "desktop"))]
    eprintln!("Build with the desktop feature to launch Mossentry.");
}
fn smoke_test() -> mossentry::error::Result<()> {
    use mossentry::{config::Config, service::Service, ssh::NativeSsh};
    let directory =
        std::env::temp_dir().join(format!("mossentry-smoke-{:032x}", rand::random::<u128>()));
    let result = (|| {
        let service = Service::open(
            Config::isolated(directory.clone()),
            std::sync::Arc::new(NativeSsh::default()),
            false,
        )?;
        let dashboard = service.request("/api/dashboard", "GET", serde_json::Value::Null)?;
        if dashboard["admin"]["desktop_mode"] != true
            || dashboard["servers"] != serde_json::json!([])
        {
            return Err(mossentry::error::Error::new(
                500,
                "Invalid desktop startup state",
            ));
        }
        service.set_preference("language", "zh")?;
        println!("Mossentry Rust startup, isolated SQLite and preferences passed.");
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(directory);
    result
}
