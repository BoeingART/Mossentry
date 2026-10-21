use crate::{
    error::{Error, Result},
    service::Service,
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
struct Cache {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    busy: bool,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Cache>);

impl UpdateState {
    fn lock(&self) -> Result<MutexGuard<'_, Cache>> {
        self.0.lock().map_err(|_| {
            Error::new(
                500,
                "Could not prepare the update. Restart Mossentry and retry.",
            )
        })
    }
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

fn failed(detail: &str, cause: impl std::fmt::Display) -> Error {
    eprintln!("Mossentry updater: {cause}");
    Error::new(502, detail)
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<String>> {
    // A development executable must never replace an installed application.
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    {
        let mut cache = state.lock()?;
        if let Some(update) = &cache.update {
            return Ok(Some(update.version.clone()));
        }
        if cache.busy {
            return Err(Error::new(409, "An update is already in progress."));
        }
        cache.busy = true;
    }
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .version_comparator(|current, release| release.version > current)
            .build()?
            .check()
            .await
    }
    .await;
    let mut cache = state.lock()?;
    cache.busy = false;
    let mut update = result.map_err(|cause| failed("Could not check for updates.", cause))?;
    if let Some(update) = &mut update {
        // The check timeout is intentionally shorter than the full package download.
        update.timeout = Some(Duration::from_secs(15 * 60));
    }
    let version = update.as_ref().map(|update| update.version.clone());
    cache.update = update;
    Ok(version)
}

#[tauri::command]
pub async fn download_update(
    state: State<'_, UpdateState>,
    progress: Channel<DownloadProgress>,
) -> Result<()> {
    let update = {
        let mut cache = state.lock()?;
        if cache.busy {
            return Err(Error::new(409, "An update is already in progress."));
        }
        if cache.bytes.is_some() {
            return Ok(());
        }
        let update = cache
            .update
            .clone()
            .ok_or_else(|| Error::bad("Check for an update first."))?;
        cache.busy = true;
        update
    };
    let mut received = 0;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let _ = progress.send(DownloadProgress { received, total });
            },
            || {},
        )
        .await;
    let mut cache = state.lock()?;
    cache.busy = false;
    // download() verifies the signature before returning bytes. A completed HTTP
    // transfer alone must not make an untrusted package available for installation.
    cache.bytes = Some(result.map_err(|cause| {
        failed(
            "Could not download or verify the update. Please retry.",
            cause,
        )
    })?);
    Ok(())
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    service: State<'_, Arc<Service>>,
    state: State<'_, UpdateState>,
) -> Result<()> {
    // Hold the same lock as SSH mutations through installation and restart. This
    // also closes the race between a UI busy check and a newly started server job.
    let _operation = service.acquire()?;
    let (update, bytes) = {
        let mut cache = state.lock()?;
        if cache.busy {
            return Err(Error::new(409, "An update is already in progress."));
        }
        let update = cache
            .update
            .clone()
            .ok_or_else(|| Error::bad("Check for an update first."))?;
        let bytes = cache
            .bytes
            .take()
            .ok_or_else(|| Error::bad("Wait for the update to finish downloading."))?;
        cache.busy = true;
        (update, bytes)
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = update.install(&bytes);
        (result, bytes)
    })
    .await;
    match result {
        Ok((Ok(()), _)) => app.restart(),
        Ok((Err(cause), bytes)) => {
            let mut cache = state.lock()?;
            cache.busy = false;
            cache.bytes = Some(bytes);
            Err(failed("Could not install the update. Please retry.", cause))
        }
        Err(cause) => {
            state.lock()?.busy = false;
            Err(failed(
                "Could not prepare the update. Restart Mossentry and retry.",
                cause,
            ))
        }
    }
}
