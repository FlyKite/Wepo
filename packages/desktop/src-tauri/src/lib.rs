use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct ImportState {
    child: Mutex<Option<CommandChild>>,
    config_path: Mutex<Option<PathBuf>>,
    cancelled: AtomicBool,
}

impl Default for ImportState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            config_path: Mutex::new(None),
            cancelled: AtomicBool::new(false),
        }
    }
}

fn importer_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|err| err.to_string())?;
    let candidates = [
        resource_dir.join("resources").join("importer"),
        resource_dir.join("importer"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("importer"),
    ];
    for dir in candidates {
        if dir.join("runner.js").is_file() {
            return Ok(dir);
        }
    }
    Err("找不到内置导入器资源".to_string())
}

fn write_import_config(payload: &Value) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "wepo-import-{}-{}.json",
        std::process::id(),
        stamp
    ));
    let body = serde_json::to_vec(payload).map_err(|err| err.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| format!("创建导入配置失败: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file.write_all(&body)
        .map_err(|err| format!("写入导入配置失败: {err}"))?;
    Ok(path)
}

fn remove_config(path: Option<PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn open_dialog_on_main_thread<F>(app: &AppHandle, picker: F) -> Result<Option<String>, String>
where
    F: FnOnce() -> Option<PathBuf> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(picker());
    })
    .map_err(|err| err.to_string())?;
    let path = rx
        .recv()
        .map_err(|err| format!("文件选择失败: {err}"))?;
    Ok(path.map(|value| value.to_string_lossy().to_string()))
}

#[tauri::command]
async fn select_backup_dir(app: AppHandle) -> Result<Option<String>, String> {
    open_dialog_on_main_thread(&app, || {
        rfd::FileDialog::new()
            .set_title("选择 iOS 备份目录")
            .pick_folder()
    })
}

#[tauri::command]
async fn select_backup_zip(app: AppHandle) -> Result<Option<String>, String> {
    open_dialog_on_main_thread(&app, || {
        rfd::FileDialog::new()
            .set_title("选择 iOS 备份 zip 包")
            .add_filter("压缩包", &["zip"])
            .pick_file()
    })
}

#[tauri::command]
fn path_exists(target: String) -> bool {
    Path::new(&target).exists()
}

#[tauri::command]
fn open_viewer(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只支持 http/https 地址".to_string());
    }
    open::that_detached(url).map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_import(
    app: AppHandle,
    state: State<'_, ImportState>,
    payload: Value,
) -> Result<(), String> {
    {
        let child = state.child.lock().map_err(|err| err.to_string())?;
        if child.is_some() {
            return Err("已有导入任务正在进行".to_string());
        }
    }

    let importer = importer_dir(&app)?;
    let runner = importer.join("runner.js");
    let config_path = write_import_config(&payload)?;
    let command = app
        .shell()
        .sidecar("node")
        .map_err(|err| format!("启动内置 Node 失败: {err}"))?
        .arg(runner.to_string_lossy().to_string())
        .arg(config_path.to_string_lossy().to_string())
        .current_dir(&importer)
        .env("UV_THREADPOOL_SIZE", "16")
        .kill_on_drop(true);

    let (mut events, child) = command
        .spawn()
        .map_err(|err| {
            remove_config(Some(config_path.clone()));
            format!("启动导入进程失败: {err}")
        })?;

    state.cancelled.store(false, Ordering::SeqCst);
    *state.child.lock().map_err(|err| err.to_string())? = Some(child);
    *state.config_path.lock().map_err(|err| err.to_string())? = Some(config_path);

    tauri::async_runtime::spawn(async move {
        let mut terminal = false;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(text) {
                        Ok(value) => {
                            if value
                                .get("event")
                                .and_then(Value::as_str)
                                .map(|name| name == "done" || name == "error")
                                .unwrap_or(false)
                            {
                                terminal = true;
                            }
                            let _ = app.emit("import-event", value);
                        }
                        Err(_) => {
                            let _ = app.emit(
                                "import-event",
                                json!({ "event": "log", "text": text }),
                            );
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let text = text.trim();
                    if !text.is_empty() {
                        let _ = app.emit(
                            "import-event",
                            json!({ "event": "log", "text": text }),
                        );
                    }
                }
                CommandEvent::Error(error) => {
                    terminal = true;
                    let _ = app.emit(
                        "import-event",
                        json!({ "event": "error", "message": error }),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<ImportState>();
                    let cancelled = state.cancelled.load(Ordering::SeqCst);
                    let _ = state.child.lock().map(|mut child| child.take());
                    let config = state
                        .config_path
                        .lock()
                        .ok()
                        .and_then(|mut path| path.take());
                    remove_config(config);
                    if !terminal && !cancelled {
                        let message = format!(
                            "导入进程已退出(code {:?}, signal {:?})",
                            payload.code, payload.signal
                        );
                        let _ = app.emit(
                            "import-event",
                            json!({ "event": "error", "message": message }),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_import(state: State<'_, ImportState>) -> Result<(), String> {
    state.cancelled.store(true, Ordering::SeqCst);
    let child = state
        .child
        .lock()
        .map_err(|err| err.to_string())?
        .take();
    let config = state
        .config_path
        .lock()
        .map_err(|err| err.to_string())?
        .take();
    remove_config(config);
    if let Some(child) = child {
        child.kill().map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ImportState::default())
        .invoke_handler(tauri::generate_handler![
            select_backup_dir,
            select_backup_zip,
            path_exists,
            open_viewer,
            start_import,
            cancel_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wepo Assistant");
}
