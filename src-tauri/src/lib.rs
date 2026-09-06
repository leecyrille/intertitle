use intertitle_core::{cards, pipeline, preview, probe, subs, tools};

use cards::CardStyle;
use pipeline::{RenderRequest, RenderResult};
use probe::MediaInfo;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tools::{ToolPaths, ToolStatus, Tools};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub tools: ToolPaths,
    pub card: CardStyle,
    pub thumbnail_count: usize,
    pub preview_width: i64,
    pub csv_extension: String,
    pub output_suffix: String,
    pub default_card_seconds: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            tools: ToolPaths::default(),
            card: CardStyle::default(),
            thumbnail_count: 120,
            preview_width: 1280,
            csv_extension: "csv".into(),
            output_suffix: " (edited)".into(),
            default_card_seconds: 10.0,
        }
    }
}

pub struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    thumb_generation: AtomicU64,
    render_cancel: Arc<AtomicBool>,
    render_pid: Arc<AtomicU32>,
    rendering: AtomicBool,
}

impl AppState {
    fn tools(&self) -> Result<Tools, String> {
        let s = self.settings.lock().unwrap();
        Tools::resolve(&s.tools)
    }
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}

fn load_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    if let Some(dir) = state.settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&state.settings_path, serde_json::to_string_pretty(&settings).unwrap()).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
async fn tool_status(state: State<'_, AppState>) -> Result<ToolStatus, String> {
    let paths = state.settings().tools;
    Ok(tools::tool_status(&paths).await)
}

#[tauri::command]
async fn probe_media(state: State<'_, AppState>, path: String) -> Result<MediaInfo, String> {
    let tools = state.tools()?;
    // any new file invalidates thumbnails in flight
    state.thumb_generation.fetch_add(1, Ordering::SeqCst);
    probe::probe(&tools, Path::new(&path)).await
}

#[tauri::command]
async fn keyframes_near(state: State<'_, AppState>, path: String, time: f64, window: f64) -> Result<Vec<f64>, String> {
    let tools = state.tools()?;
    probe::keyframes_between(&tools, Path::new(&path), time - window, time + window).await
}

#[tauri::command]
async fn nearest_keyframe(state: State<'_, AppState>, path: String, time: f64, duration: f64) -> Result<f64, String> {
    let tools = state.tools()?;
    probe::nearest_keyframe(&tools, Path::new(&path), time, duration).await
}

#[tauri::command]
async fn frame_at(state: State<'_, AppState>, path: String, time: f64, width: i64, accurate: bool) -> Result<String, String> {
    let tools = state.tools()?;
    preview::frame_jpeg(&tools, Path::new(&path), time, width, accurate).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbEvent {
    index: usize,
    count: usize,
    time: f64,
    data: String,
}

#[tauri::command]
async fn start_thumbnails(app: AppHandle, state: State<'_, AppState>, path: String, duration: f64, count: usize, width: i64) -> Result<(), String> {
    let tools = state.tools()?;
    let generation = state.thumb_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let count = count.clamp(10, 600);
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();
        for i in 0..count {
            if st.thumb_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let t = (i as f64 + 0.5) * duration / count as f64;
            if let Ok(data) = preview::frame_jpeg(&tools, Path::new(&path), t, width, false).await {
                if st.thumb_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                let _ = app.emit("thumbnail", ThumbEvent { index: i, count, time: t, data });
            }
        }
        let _ = app.emit("thumbnails-done", generation);
    });
    Ok(())
}

#[tauri::command]
async fn preview_clip(state: State<'_, AppState>, path: String, start: f64, duration: f64, height: i64, audio_index: Option<usize>) -> Result<String, String> {
    let tools = state.tools()?;
    preview::proxy_clip(&tools, Path::new(&path), start, duration, height, audio_index).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleText {
    format: String,
    text: String,
}

#[tauri::command]
async fn subtitle_text(state: State<'_, AppState>, path: String, stream_index: usize) -> Result<SubtitleText, String> {
    let tools = state.tools()?;
    let info = probe::probe(&tools, Path::new(&path)).await?;
    let sub = info.subtitles.iter().find(|s| s.index == stream_index).ok_or("subtitle stream not found")?;
    let (format, text) = subs::extract_text(&tools, Path::new(&path), sub).await?;
    Ok(SubtitleText { format, text })
}

#[tauri::command]
async fn render(app: AppHandle, state: State<'_, AppState>, request: RenderRequest) -> Result<RenderResult, String> {
    if state.rendering.swap(true, Ordering::SeqCst) {
        return Err("A render is already running.".into());
    }
    state.render_cancel.store(false, Ordering::SeqCst);
    let tools = match state.tools() {
        Ok(t) => t,
        Err(e) => {
            state.rendering.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let (a1, a2) = (app.clone(), app.clone());
    let on_progress: pipeline::ProgressFn = Arc::new(move |p| {
        let _ = a1.emit("render-progress", p);
    });
    let on_log: pipeline::LogFn = Arc::new(move |line: &str| {
        let _ = a2.emit("render-log", line.to_string());
    });
    let mut runner = pipeline::Runner::new(tools, state.render_cancel.clone(), state.render_pid.clone(), on_progress, on_log);
    let res = pipeline::run(&mut runner, request).await;
    state.rendering.store(false, Ordering::SeqCst);
    res
}

#[tauri::command]
fn cancel_render(state: State<AppState>) -> Result<(), String> {
    state.render_cancel.store(true, Ordering::SeqCst);
    let pid = state.render_pid.load(Ordering::SeqCst);
    if pid != 0 {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
        }
    }
    Ok(())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn default_font() -> Option<String> {
    cards::default_font().map(|p| p.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
            let settings_path = dir.join("settings.json");
            app.manage(AppState {
                settings: Mutex::new(load_settings(&settings_path)),
                settings_path,
                thumb_generation: AtomicU64::new(0),
                render_cancel: Arc::new(AtomicBool::new(false)),
                render_pid: Arc::new(AtomicU32::new(0)),
                rendering: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            tool_status,
            probe_media,
            keyframes_near,
            nearest_keyframe,
            frame_at,
            start_thumbnails,
            preview_clip,
            subtitle_text,
            render,
            cancel_render,
            read_text_file,
            write_text_file,
            path_exists,
            default_font
        ])
        .run(tauri::generate_context!())
        .expect("error while running Intertitle");
}
