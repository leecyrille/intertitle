//! Locating and running the external tools (ffmpeg, ffprobe, mkvmerge).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaths {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub mkvmerge: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub mkvmerge: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub mkvmerge_version: Option<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for p in std::env::split_paths(&path) {
            dirs.push(p);
        }
    }
    if cfg!(windows) {
        for base in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(b) = std::env::var(base) {
                let b = PathBuf::from(b);
                dirs.push(b.join("MKVToolNix"));
                dirs.push(b.join("ffmpeg").join("bin"));
                dirs.push(b.join("Microsoft").join("WinGet").join("Links"));
            }
        }
        dirs.push(PathBuf::from("C:\\ffmpeg\\bin"));
        dirs.push(PathBuf::from("C:\\Program Files\\MKVToolNix"));
    } else {
        for d in [
            "/usr/local/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
            "/opt/local/bin",
            "/Applications/MKVToolNix.app/Contents/MacOS",
        ] {
            dirs.push(PathBuf::from(d));
        }
    }
    dirs
}

pub fn find_tool(name: &str, user_override: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = user_override {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Some(pb);
            }
            // user may have given a directory
            let inside = pb.join(exe(name));
            if inside.is_file() {
                return Some(inside);
            }
        }
    }
    let file = exe(name);
    for d in candidate_dirs() {
        let p = d.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[derive(Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub mkvmerge: Option<PathBuf>,
}

impl Tools {
    pub fn resolve(overrides: &ToolPaths) -> Result<Tools, String> {
        let ffmpeg = find_tool("ffmpeg", overrides.ffmpeg.as_deref())
            .ok_or("ffmpeg was not found. Install it or set its location in Settings.")?;
        let ffprobe = find_tool("ffprobe", overrides.ffprobe.as_deref())
            .ok_or("ffprobe was not found. It ships with ffmpeg; set its location in Settings.")?;
        let mkvmerge = find_tool("mkvmerge", overrides.mkvmerge.as_deref());
        Ok(Tools { ffmpeg, ffprobe, mkvmerge })
    }

    pub fn require_mkvmerge(&self) -> Result<&Path, String> {
        self.mkvmerge.as_deref().ok_or_else(|| {
            "mkvmerge (part of MKVToolNix) was not found. Install MKVToolNix or set its location in Settings."
                .to_string()
        })
    }
}

pub async fn tool_status(overrides: &ToolPaths) -> ToolStatus {
    let ffmpeg = find_tool("ffmpeg", overrides.ffmpeg.as_deref());
    let ffprobe = find_tool("ffprobe", overrides.ffprobe.as_deref());
    let mkvmerge = find_tool("mkvmerge", overrides.mkvmerge.as_deref());
    let ffmpeg_version = match &ffmpeg {
        Some(p) => run_capture(p, &["-version"]).await.ok().and_then(|o| {
            o.lines().next().map(|l| l.trim().to_string())
        }),
        None => None,
    };
    let mkvmerge_version = match &mkvmerge {
        Some(p) => run_capture(p, &["--version"]).await.ok().map(|o| o.trim().to_string()),
        None => None,
    };
    ToolStatus {
        ffmpeg: ffmpeg.map(|p| p.display().to_string()),
        ffprobe: ffprobe.map(|p| p.display().to_string()),
        mkvmerge: mkvmerge.map(|p| p.display().to_string()),
        ffmpeg_version,
        mkvmerge_version,
    }
}

pub fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null());
    c.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run a tool and return stdout as a string. stderr is folded into the error.
pub async fn run_capture<S: AsRef<std::ffi::OsStr>>(program: &Path, args: &[S]) -> Result<String, String> {
    let out = command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "{} exited with {}:\n{}",
            program.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            out.status,
            tail
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Run a tool and return raw stdout bytes.
pub async fn run_capture_bytes<S: AsRef<std::ffi::OsStr>>(program: &Path, args: &[S]) -> Result<Vec<u8>, String> {
    let out = command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("{} failed:\n{}", program.display(), tail));
    }
    Ok(out.stdout)
}

/// Spawn a long-running tool, streaming every stdout/stderr line to `on_line`.
/// The child is registered through `register` so the caller can kill it on cancel.
pub async fn run_streaming<F, R>(
    program: &Path,
    args: &[String],
    tolerated_exit_codes: &[i32],
    mut on_line: F,
    register: R,
) -> Result<(), String>
where
    F: FnMut(&str) + Send,
    R: FnOnce(&mut Child),
{
    let mut child = command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    register(&mut child);
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_tail: Vec<String> = Vec::new();

    // stderr is read to a buffer concurrently (ffmpeg writes progress with \r).
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut r = BufReader::new(stderr);
        let _ = r.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).to_string()
    });

    while let Ok(Some(line)) = out_lines.next_line().await {
        on_line(&line);
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let err_text = err_task.await.unwrap_or_default();
    for l in err_text.replace('\r', "\n").lines() {
        if !l.trim().is_empty() {
            on_line(l);
            err_tail.push(l.to_string());
        }
    }
    let tolerated = status.code().map(|c| tolerated_exit_codes.contains(&c)).unwrap_or(false);
    if !status.success() && !tolerated {
        let tail: Vec<String> = err_tail.iter().rev().take(15).cloned().collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!(
            "{} exited with {}\n{}",
            program.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            status,
            tail.join("\n")
        ));
    }
    Ok(())
}

/// Escape a path for use inside an ffmpeg filter option (drawtext fontfile / textfile).
pub fn filter_path(p: &Path) -> String {
    let s = p.display().to_string().replace('\\', "/");
    let s = s.replace(':', "\\:").replace('\'', "\\\\\\'");
    format!("'{s}'")
}
