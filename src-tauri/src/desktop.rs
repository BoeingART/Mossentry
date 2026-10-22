use crate::{
    config::Config,
    error::{Error, Result},
    service::Service,
    ssh::NativeSsh,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State};

type AppService = Arc<Service>;
#[tauri::command]
async fn request(
    service: State<'_, AppService>,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = service.request(&path, &method, body.unwrap_or(Value::Null));
        if cfg!(debug_assertions) && path == "/api/dashboard" && result.is_ok() {
            eprintln!("Mossentry: desktop UI connected to Rust");
        }
        result
    })
    .await
    .map_err(|_| Error::new(500, "The local operation stopped unexpectedly"))?
}
#[tauri::command]
fn get_appearance(service: State<'_, AppService>) -> Result<Value> {
    service.appearance()
}
#[tauri::command]
fn set_appearance(service: State<'_, AppService>, key: String, value: String) -> Result<()> {
    service.set_preference(&key, &value)
}
#[tauri::command]
async fn download_credentials(service: State<'_, AppService>, action_id: i64) -> Result<bool> {
    let filename = service.credentials_name(action_id)?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(filename)
        .add_filter("ZIP archive", &["zip"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let path = file.path().to_path_buf();
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.save_credentials(action_id, &path))
        .await
        .map_err(|_| Error::new(500, "Could not save credentials"))??;
    Ok(true)
}
#[tauri::command]
async fn choose_ssh_config() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_directory(crate::config::expand_path("~/.ssh"))
        .set_file_name("config")
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}
#[tauri::command]
async fn save_json(filename: String, value: Value) -> Result<bool> {
    if filename.len() > 120
        || !filename.starts_with("mossentry-")
        || !filename.ends_with(".json")
        || filename.contains(['/', '\\'])
    {
        return Err(Error::bad("Invalid export filename"));
    }
    let bytes = serde_json::to_vec_pretty(&value)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(Error::bad("Export is too large"));
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(filename)
        .add_filter("JSON", &["json"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        use std::io::Write;
        let mut f = crate::config::private_file(&path, false)?;
        f.set_len(0)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        Ok(())
    })
    .await
    .map_err(|_| Error::new(500, "Could not save export"))??;
    Ok(true)
}
pub fn run() {
    let result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(crate::updates::UpdateState::default())
            .invoke_handler(tauri::generate_handler![
                choose_ssh_config,
                request,
                get_appearance,
                set_appearance,
                download_credentials,
                save_json,
                crate::updates::check_update,
                crate::updates::download_update,
                crate::updates::install_update
            ])
            .setup(|app| {
                app.manage(Service::open(
                    Config::discover()?,
                    Arc::new(NativeSsh::default()),
                )?);
                let config = app.config().app.windows[0].clone();
                let window = tauri::WebviewWindowBuilder::from_config(app, &config)?;
                #[cfg(target_os = "macos")]
                let window = window
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
                #[cfg(not(target_os = "macos"))]
                let window = window.decorations(false);
                window
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_navigation(|url| {
                        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                            || (["http", "https"].contains(&url.scheme())
                                && url.host_str() == Some("tauri.localhost"))
                            || (cfg!(debug_assertions)
                                && url.scheme() == "http"
                                && url.host_str() == Some("127.0.0.1")
                                && url.port() == Some(5173))
                    })
                    .build()?;
                Ok(())
            })
            .run(tauri::generate_context!())?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Mossentry startup failed: {error}");
        rfd::MessageDialog::new()
            .set_title("Mossentry — Startup failed")
            .set_description(error.to_string())
            .set_level(rfd::MessageLevel::Error)
            .show();
        std::process::exit(1);
    }
}
