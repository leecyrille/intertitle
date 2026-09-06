//! The render pipeline. Everything that can be stream-copied is stream-copied;
//! only the inserted cards and silence are encoded.
//!
//! Passes, in order:
//! 1. Mute      – audio-only chain: split at the exact times, swap muted parts for silence, re-join.
//! 2. Overlay   – video-only chain: split at keyframes, swap parts for text cards (same frame count), re-join.
//! 3. Cut/Card  – video+audio chain: split at keyframes, drop removed ranges, insert cards, re-join.
//! 4. Subtitles and chapters are retimed through the resulting timeline map and muxed with mkvmerge.

use crate::cards::{card_args, silence_args, CardSpec, CardStyle};
use crate::probe::{self, MediaInfo, VideoInfo};
use crate::subs;
use crate::timeline::{Piece, TimelineMap};
use crate::tools::{run_capture, run_streaming, Tools};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    Remove,
    Replace,
    TextOverVideo,
    Mute,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DurationMode {
    Fixed,
    Match,
}

fn default_duration() -> f64 {
    10.0
}
fn default_true() -> bool {
    true
}
fn default_mode() -> DurationMode {
    DurationMode::Fixed
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: String,
    pub kind: EditKind,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_mode")]
    pub duration_mode: DurationMode,
    #[serde(default = "default_duration")]
    pub duration: f64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub path: String,
    pub edits: Vec<Edit>,
    pub output: String,
    /// "mkv" or "mp4"
    pub container: String,
    pub style: CardStyle,
    #[serde(default)]
    pub keep_temp: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppliedEdit {
    pub id: String,
    pub kind: EditKind,
    pub requested_start: f64,
    pub requested_end: f64,
    pub actual_start: f64,
    pub actual_end: f64,
    pub card_seconds: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub output: String,
    pub duration: f64,
    pub original_duration: f64,
    pub warnings: Vec<String>,
    pub applied: Vec<AppliedEdit>,
    pub seconds_encoded: f64,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub percent: f64,
    pub message: String,
}

/// Called with every progress update while rendering.
pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;
/// Called with every command line and every line the tools print.
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Runner {
    pub tools: Tools,
    pub cancel: Arc<AtomicBool>,
    pub child_pid: Arc<AtomicU32>,
    on_progress: ProgressFn,
    on_log: LogFn,
    stage: String,
    base: f64,
    span: f64,
}

impl Runner {
    pub fn new(tools: Tools, cancel: Arc<AtomicBool>, child_pid: Arc<AtomicU32>, on_progress: ProgressFn, on_log: LogFn) -> Self {
        Runner { tools, cancel, child_pid, on_progress, on_log, stage: String::new(), base: 0.0, span: 1.0 }
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("Cancelled".into())
        } else {
            Ok(())
        }
    }

    fn stage(&mut self, name: &str, base: f64, span: f64, message: &str) {
        self.stage = name.to_string();
        self.base = base;
        self.span = span;
        self.progress(0.0, message);
    }

    fn progress(&self, frac: f64, message: &str) {
        (self.on_progress)(Progress { stage: self.stage.clone(), percent: (self.base + self.span * frac.clamp(0.0, 1.0)) * 100.0, message: message.to_string() });
    }

    fn log(&self, line: &str) {
        (self.on_log)(line);
    }

    async fn mkvmerge(&self, args: &[String], frac_scale: f64) -> Result<(), String> {
        self.check_cancel()?;
        let mkv = self.tools.require_mkvmerge()?.to_path_buf();
        self.log(&format!("> mkvmerge {}", shell_join(args)));
        let pid = self.child_pid.clone();
        let on_progress = self.on_progress.clone();
        let on_log = self.on_log.clone();
        let stage = self.stage.clone();
        let (base, span) = (self.base, self.span);
        run_streaming(
            &mkv,
            args,
            &[1], // mkvmerge exits with 1 when it only printed warnings
            |line| {
                if let Some(p) = line.strip_prefix("Progress: ") {
                    if let Ok(v) = p.trim_end_matches('%').trim().parse::<f64>() {
                        on_progress(Progress { stage: stage.clone(), percent: (base + span * (v / 100.0) * frac_scale) * 100.0, message: String::new() });
                    }
                } else if (line.contains("Error") || line.contains("Warning")) && !line.contains("codec's private data does not match") {
                    // the codec-private warning is expected: cards carry their parameter sets in-band
                    on_log(line);
                }
            },
            |child| pid.store(child.id().unwrap_or(0), Ordering::SeqCst),
        )
        .await?;
        self.child_pid.store(0, Ordering::SeqCst);
        self.check_cancel()
    }

    async fn ffmpeg(&self, args: &[String], total_frames: Option<i64>) -> Result<(), String> {
        self.check_cancel()?;
        self.log(&format!("> ffmpeg {}", shell_join(args)));
        let pid = self.child_pid.clone();
        let on_progress = self.on_progress.clone();
        let on_log = self.on_log.clone();
        let stage = self.stage.clone();
        let (base, span) = (self.base, self.span);
        run_streaming(
            &self.tools.ffmpeg,
            args,
            &[],
            |line| {
                if let Some(f) = line.strip_prefix("frame=") {
                    if let (Some(total), Ok(n)) = (total_frames, f.trim().parse::<i64>()) {
                        if total > 0 {
                            on_progress(Progress { stage: stage.clone(), percent: (base + span * (n as f64 / total as f64)) * 100.0, message: String::new() });
                        }
                    }
                } else if !line.starts_with("out_time")
                    && !line.starts_with("bitrate")
                    && !line.starts_with("total_size")
                    && !line.starts_with("speed")
                    && !line.starts_with("fps")
                    && !line.starts_with("stream_")
                    && !line.starts_with("dup_")
                    && !line.starts_with("drop_")
                    && !line.starts_with("progress")
                {
                    on_log(line);
                }
            },
            |child| pid.store(child.id().unwrap_or(0), Ordering::SeqCst),
        )
        .await?;
        self.child_pid.store(0, Ordering::SeqCst);
        self.check_cancel()
    }

    /// Rewrite a piece so its video packets carry their own SPS/PPS (H.264/HEVC only).
    /// mkvmerge keeps a single codec-private block for the whole joined track, so the
    /// card and the segment right after it must announce their parameter sets in-band.
    async fn inband(&self, video: &VideoInfo, file: &Path) -> Result<PathBuf, String> {
        let bsf = match video.codec.as_str() {
            "h264" => "h264_mp4toannexb",
            "hevc" => "hevc_mp4toannexb",
            _ => return Ok(file.to_path_buf()),
        };
        let out = file.with_file_name(format!("{}-ib.mkv", file.file_stem().unwrap().to_string_lossy()));
        let args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
            .iter()
            .map(|s| s.to_string())
            .chain([file.display().to_string(), "-map".into(), "0".into(), "-c".into(), "copy".into(), "-bsf:v".into(), bsf.into(), out.display().to_string()])
            .collect();
        self.ffmpeg(&args, None).await?;
        Ok(out)
    }
}

fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|a| if a.contains(' ') || a.contains(':') && a.contains('\\') { format!("\"{a}\"") } else { a.clone() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// mkvmerge splits right before the first keyframe at or after a timestamp; nudge
/// boundaries a hair early so a keyframe exactly on the boundary is chosen, never skipped.
fn secs(t: f64) -> String {
    let t = if t > 0.001 { t - 0.0005 } else { 0.0 };
    format!("{:.4}s", t)
}

/// mkvmerge "parts:" spec for consecutive ranges. `None` end = to the end of the file.
fn parts_spec(ranges: &[(f64, Option<f64>)]) -> String {
    let items: Vec<String> = ranges
        .iter()
        .map(|(a, b)| match b {
            Some(b) => format!("{}-{}", secs(*a), secs(*b)),
            None => format!("{}-", secs(*a)),
        })
        .collect();
    format!("parts:{}", items.join(","))
}

fn split_names(base: &Path, n: usize) -> Vec<PathBuf> {
    let stem = base.file_stem().unwrap().to_string_lossy().to_string();
    let ext = base.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mkv".into());
    (1..=n).map(|i| base.with_file_name(format!("{stem}-{i:03}.{ext}"))).collect()
}

/// Container duration (seconds) as mkvmerge sees it: this is what appending offsets by.
async fn mkv_duration(tools: &Tools, file: &Path) -> Result<f64, String> {
    let mkv = tools.require_mkvmerge()?;
    let out = run_capture(mkv, &["-J", &file.display().to_string()]).await?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let ns = v
        .get("container")
        .and_then(|c| c.get("properties"))
        .and_then(|p| p.get("duration"))
        .and_then(|d| d.as_f64())
        .ok_or("mkvmerge did not report a duration")?;
    Ok(ns / 1e9)
}

async fn video_packet_count(tools: &Tools, file: &Path) -> Result<i64, String> {
    let out = run_capture(
        &tools.ffprobe,
        &["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", &file.display().to_string()],
    )
    .await?;
    out.trim().trim_end_matches(',').parse::<i64>().map_err(|_| format!("could not count frames in {}", file.display()))
}

fn mkvmerge_readable(container: &str) -> bool {
    // ffprobe format_name values that mkvmerge reads reliably and whose timestamps start at zero
    container.starts_with("matroska") || container.starts_with("webm") || container.contains("mp4") || container.contains("mov") || container == "avi"
}

fn needs_inband(video: &VideoInfo) -> bool {
    matches!(video.codec.as_str(), "h264" | "hevc")
}

/// One element of an output chain, in order.
#[derive(Clone, Debug)]
enum Plan {
    /// Index into the kept-ranges list; `inband` = rewrite with in-band parameter sets
    Kept { idx: usize, inband: bool },
    /// Index into the edit list this card stands in for
    Card { edit: usize },
}

/// Append a kept range to the plan. When it directly follows a card (and the codec needs it),
/// split off a short head so only that small piece gets the in-band rewrite.
#[allow(clippy::too_many_arguments)]
async fn push_kept(
    tools: &Tools,
    src: &Path,
    duration: f64,
    video: &VideoInfo,
    start: f64,
    end: Option<f64>,
    after_card: bool,
    kept: &mut Vec<(f64, Option<f64>)>,
    plan: &mut Vec<Plan>,
) -> Result<(), String> {
    let end_val = end.unwrap_or(duration);
    if after_card && needs_inband(video) && end_val - start > 8.0 {
        let h = probe::nearest_keyframe(tools, src, start + 4.0, duration).await?;
        if h > start + 0.5 && h < end_val - 0.5 {
            plan.push(Plan::Kept { idx: kept.len(), inband: true });
            kept.push((start, Some(h)));
            plan.push(Plan::Kept { idx: kept.len(), inband: false });
            kept.push((h, end));
            return Ok(());
        }
    }
    plan.push(Plan::Kept { idx: kept.len(), inband: after_card && needs_inband(video) });
    kept.push((start, end));
    Ok(())
}

pub async fn run(r: &mut Runner, req: RenderRequest) -> Result<RenderResult, String> {
    let tools = r.tools.clone();
    tools.require_mkvmerge()?;
    let mut warnings: Vec<String> = Vec::new();
    let output = PathBuf::from(&req.output);
    let out_dir = output.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create output folder: {e}"))?;
    let work = out_dir.join(format!(".intertitle-work-{}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| format!("cannot create work folder: {e}"))?;

    let result = build(r, &req, &work, &mut warnings).await;

    if !req.keep_temp {
        let _ = std::fs::remove_dir_all(&work);
    }
    let mut res = result?;
    res.warnings = warnings;
    Ok(res)
}

async fn build(r: &mut Runner, req: &RenderRequest, work: &Path, warnings: &mut Vec<String>) -> Result<RenderResult, String> {
    let tools = r.tools.clone();
    r.stage("probe", 0.0, 0.02, "Reading the movie");
    let source_in = PathBuf::from(&req.path);
    let mut info: MediaInfo = probe::probe(&tools, &source_in).await?;
    let original_duration = info.duration;
    let video = info.video.clone().ok_or("The file has no video stream.")?;
    let fps = video.fps();

    // ---- validate edits ---------------------------------------------------
    let mut edits: Vec<Edit> = req.edits.iter().filter(|e| e.enabled).cloned().collect();
    if edits.is_empty() {
        return Err("There are no enabled edits to apply.".into());
    }
    for e in &edits {
        if !(e.start >= 0.0 && e.end > e.start && e.start < info.duration) {
            return Err(format!("Edit {} has an invalid range ({:.3} to {:.3}).", e.id, e.start, e.end));
        }
        if matches!(e.kind, EditKind::Replace | EditKind::TextOverVideo) && e.text.trim().is_empty() {
            return Err(format!("Edit {} needs some text for its card.", e.id));
        }
    }
    edits.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    for w in edits.windows(2) {
        if w[1].start < w[0].end - 0.001 {
            return Err(format!("Edits overlap: {:.2}-{:.2} and {:.2}-{:.2}.", w[0].start, w[0].end, w[1].start, w[1].end));
        }
    }
    for e in edits.iter_mut() {
        e.end = e.end.min(info.duration);
    }

    // ---- make sure mkvmerge can read the source with zero-based timestamps -
    let mut source = source_in.clone();
    let needs_remux = !mkvmerge_readable(&info.container) || {
        let out = run_capture(&tools.ffprobe, &["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", &req.path]).await.unwrap_or_default();
        out.trim().parse::<f64>().map(|s| s.abs() > 0.01).unwrap_or(false)
    };
    if needs_remux {
        r.stage("remux", 0.02, 0.08, "Remuxing the source into MKV (no re-encoding)");
        let remuxed = work.join("source.mkv");
        let args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i", &req.path, "-map", "0", "-map", "-0:d", "-map", "-0:t", "-c", "copy", "-avoid_negative_ts", "make_zero"]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(remuxed.display().to_string()))
            .collect();
        r.ffmpeg(&args, video.nb_frames).await?;
        source = remuxed;
        info = probe::probe(&tools, &source).await?;
    }
    let src = source.display().to_string();

    // ---- snap card/remove boundaries to keyframes ---------------------------
    r.stage("snap", 0.10, 0.03, "Finding keyframes near the cut points");
    let mut applied: Vec<AppliedEdit> = Vec::new();
    let mut snapped: Vec<(Edit, f64, f64)> = Vec::new(); // edit, actual start, actual end
    for e in &edits {
        let (a, b) = if e.kind == EditKind::Mute {
            (e.start, e.end)
        } else {
            let a = probe::nearest_keyframe(&tools, &source, e.start, info.duration).await?;
            let b = if e.end >= info.duration - 0.05 { info.duration } else { probe::nearest_keyframe(&tools, &source, e.end, info.duration).await? };
            if b - a < 1.0 / fps {
                return Err(format!(
                    "Edit at {:.2}s is shorter than the distance between keyframes there; nothing can be cut without re-encoding. Widen it a little.",
                    e.start
                ));
            }
            (a, b)
        };
        snapped.push((e.clone(), a, b));
    }
    for w in snapped.windows(2) {
        if w[1].1 < w[0].2 - 0.0005 {
            return Err(format!(
                "After snapping to keyframes, the edits at {:.2}s and {:.2}s overlap. Move them a little further apart.",
                w[0].0.start, w[1].0.start
            ));
        }
    }

    let mutes: Vec<(Edit, f64, f64)> = snapped.iter().filter(|(e, _, _)| e.kind == EditKind::Mute).cloned().collect();
    let overlays: Vec<(Edit, f64, f64)> = snapped.iter().filter(|(e, _, _)| e.kind == EditKind::TextOverVideo).cloned().collect();
    let cuts: Vec<(Edit, f64, f64)> = snapped.iter().filter(|(e, _, _)| matches!(e.kind, EditKind::Remove | EditKind::Replace)).cloned().collect();
    let mut seconds_encoded = 0.0;

    // ---- pass 1: mute (audio only, timeline unchanged) -----------------------
    let mut audio_src: Option<PathBuf> = None;
    if !mutes.is_empty() {
        if info.audio.is_empty() {
            warnings.push("Mute edits were ignored because the file has no audio.".into());
        } else {
            r.stage("mute", 0.13, 0.12, "Cutting the audio around muted sections");
            let mut ranges: Vec<(f64, Option<f64>)> = Vec::new();
            let mut muted_idx: Vec<usize> = Vec::new();
            let mut cursor = 0.0;
            for (_, a, b) in &mutes {
                if *a > cursor + 0.0005 {
                    ranges.push((cursor, Some(*a)));
                }
                muted_idx.push(ranges.len());
                ranges.push((*a, Some(*b)));
                cursor = *b;
            }
            if cursor < info.duration - 0.0005 {
                ranges.push((cursor, None));
            }
            let base = work.join("aud.mkv");
            let args: Vec<String> = vec![
                "-o".into(),
                base.display().to_string(),
                "--no-video".into(),
                "--no-subtitles".into(),
                "--no-chapters".into(),
                "--no-global-tags".into(),
                "--split".into(),
                parts_spec(&ranges),
                src.clone(),
            ];
            r.mkvmerge(&args, 0.7).await?;
            let files = split_names(&base, ranges.len());
            let mut chain: Vec<String> = Vec::new();
            for (i, f) in files.iter().enumerate() {
                if muted_idx.contains(&i) {
                    let dur = mkv_duration(&tools, f).await?;
                    let sil = work.join(format!("silence-{i}.mkv"));
                    r.ffmpeg(&silence_args(&info.audio, dur, &sil)?, None).await?;
                    seconds_encoded += dur;
                    chain.push(sil.display().to_string());
                } else {
                    chain.push(f.display().to_string());
                }
            }
            let out = work.join("audio.mkv");
            r.mkvmerge(&append_args(&out, &chain), 0.3).await?;
            audio_src = Some(out);
            for (e, a, b) in &mutes {
                applied.push(AppliedEdit { id: e.id.clone(), kind: e.kind.clone(), requested_start: e.start, requested_end: e.end, actual_start: *a, actual_end: *b, card_seconds: None });
            }
        }
    }

    // ---- pass 2: text over video (video only, timeline unchanged) -----------
    let mut video_src: Option<PathBuf> = None;
    if !overlays.is_empty() {
        r.stage("overlay", 0.25, 0.15, "Replacing video with text cards (audio kept)");
        let mut kept: Vec<(f64, Option<f64>)> = Vec::new();
        let mut plan: Vec<Plan> = Vec::new();
        let mut cursor = 0.0;
        let mut after_card = false;
        for (i, (e, a, b)) in overlays.iter().enumerate() {
            if *a > cursor + 0.5 / fps {
                push_kept(&tools, &source, info.duration, &video, cursor, Some(*a), after_card, &mut kept, &mut plan).await?;
            }
            // the overlay range itself is split out too, so its frame count can be measured
            plan.push(Plan::Card { edit: i });
            kept.push((*a, Some(*b)));
            cursor = *b;
            after_card = true;
            applied.push(AppliedEdit { id: e.id.clone(), kind: e.kind.clone(), requested_start: e.start, requested_end: e.end, actual_start: *a, actual_end: *b, card_seconds: Some(b - a) });
        }
        if cursor < info.duration - 0.5 / fps {
            push_kept(&tools, &source, info.duration, &video, cursor, None, after_card, &mut kept, &mut plan).await?;
        }
        let base = work.join("vid.mkv");
        let args: Vec<String> = vec![
            "-o".into(),
            base.display().to_string(),
            "--no-audio".into(),
            "--no-subtitles".into(),
            "--no-chapters".into(),
            "--no-global-tags".into(),
            "--split".into(),
            parts_spec(&kept),
            src.clone(),
        ];
        r.mkvmerge(&args, 0.4).await?;
        let files = split_names(&base, kept.len());
        let mut chain: Vec<String> = Vec::new();
        let mut range_i = 0; // walks `kept` in order; cards consume the range they replaced
        for p in &plan {
            match p {
                Plan::Kept { idx, inband } => {
                    let f = &files[*idx];
                    chain.push(if *inband { r.inband(&video, f).await?.display().to_string() } else { f.display().to_string() });
                    range_i = idx + 1;
                }
                Plan::Card { edit } => {
                    let f = &files[range_i];
                    range_i += 1;
                    let frames = video_packet_count(&tools, f).await?;
                    let card = work.join(format!("overlay-{edit}.mkv"));
                    let spec = CardSpec { video: &video, audio: &[], text: &overlays[*edit].0.text, frames, style: &req.style, out: &card, work_dir: work };
                    r.ffmpeg(&card_args(&spec)?, Some(frames)).await?;
                    seconds_encoded += frames as f64 / fps;
                    chain.push(r.inband(&video, &card).await?.display().to_string());
                }
            }
        }
        let out = work.join("video.mkv");
        r.mkvmerge(&append_args(&out, &chain), 0.3).await?;
        video_src = Some(out);
    }

    // ---- pass 3: remove / replace (timeline changes) --------------------------
    let mut map = TimelineMap::identity(info.duration);
    let mut va: Option<PathBuf> = None;
    if !cuts.is_empty() {
        r.stage("split", 0.40, 0.25, "Splitting the movie at the cut points (stream copy)");
        let split_input: PathBuf = video_src.clone().unwrap_or_else(|| source.clone());
        let mut kept: Vec<(f64, Option<f64>)> = Vec::new();
        let mut plan: Vec<Plan> = Vec::new();
        let mut cursor = 0.0;
        let mut after_card = false;
        for (ci, (e, a, b)) in cuts.iter().enumerate() {
            if *a > cursor + 0.5 / fps {
                push_kept(&tools, &split_input, info.duration, &video, cursor, Some(*a), after_card, &mut kept, &mut plan).await?;
            }
            after_card = false;
            if e.kind == EditKind::Replace {
                plan.push(Plan::Card { edit: ci });
                after_card = true;
            }
            cursor = *b;
        }
        if cursor < info.duration - 0.5 / fps {
            push_kept(&tools, &split_input, info.duration, &video, cursor, None, after_card, &mut kept, &mut plan).await?;
        }
        if kept.is_empty() {
            return Err("Everything would be removed; nothing left to write.".into());
        }
        let base = work.join("seg.mkv");
        let mut args: Vec<String> = vec!["-o".into(), base.display().to_string(), "--no-subtitles".into(), "--no-chapters".into(), "--no-global-tags".into()];
        match (&video_src, &audio_src) {
            (None, None) => args.push(src.clone()),
            (v, a) => {
                args.extend(["--no-audio".into(), v.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| src.clone())]);
                if !info.audio.is_empty() {
                    args.extend(["--no-video".into(), a.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| src.clone())]);
                }
            }
        }
        args.extend(["--split".into(), parts_spec(&kept)]);
        r.mkvmerge(&args, 1.0).await?;
        let seg_files = split_names(&base, kept.len());

        r.stage("cards", 0.65, 0.12, "Rendering title cards");
        let mut chain: Vec<String> = Vec::new();
        let mut pieces: Vec<Piece> = Vec::new();
        let n_cards = plan.iter().filter(|p| matches!(p, Plan::Card { .. })).count().max(1);
        let mut done_cards = 0;
        for p in &plan {
            match p {
                Plan::Card { edit } => {
                    let (e, a, b) = &cuts[*edit];
                    let seconds = match e.duration_mode {
                        DurationMode::Match => b - a,
                        DurationMode::Fixed => e.duration.max(0.5),
                    };
                    let frames = (seconds * fps).round().max(1.0) as i64;
                    let card = work.join(format!("card-{edit}.mkv"));
                    let spec = CardSpec { video: &video, audio: &info.audio, text: &e.text, frames, style: &req.style, out: &card, work_dir: work };
                    r.ffmpeg(&card_args(&spec)?, Some(frames)).await?;
                    done_cards += 1;
                    r.progress(done_cards as f64 / n_cards as f64, "Rendering title cards");
                    seconds_encoded += frames as f64 / fps;
                    let card = r.inband(&video, &card).await?;
                    let dur = mkv_duration(&tools, &card).await?;
                    pieces.push(Piece::Card { dur });
                    chain.push(card.display().to_string());
                    applied.push(AppliedEdit { id: e.id.clone(), kind: e.kind.clone(), requested_start: e.start, requested_end: e.end, actual_start: *a, actual_end: *b, card_seconds: Some(frames as f64 / fps) });
                }
                Plan::Kept { idx, inband } => {
                    let f = &seg_files[*idx];
                    let f = if *inband { r.inband(&video, f).await? } else { f.clone() };
                    let dur = mkv_duration(&tools, &f).await?;
                    let (a, b) = kept[*idx];
                    pieces.push(Piece::Kept { src_start: a, src_end: b.unwrap_or(info.duration), dur });
                    chain.push(f.display().to_string());
                }
            }
        }
        for (e, a, b) in cuts.iter().filter(|(e, _, _)| e.kind == EditKind::Remove) {
            applied.push(AppliedEdit { id: e.id.clone(), kind: e.kind.clone(), requested_start: e.start, requested_end: e.end, actual_start: *a, actual_end: *b, card_seconds: None });
        }
        map = TimelineMap::new(pieces);

        r.stage("join", 0.77, 0.10, "Joining the pieces (stream copy)");
        let out = work.join("va.mkv");
        r.mkvmerge(&append_args(&out, &chain), 1.0).await?;
        va = Some(out);
    }

    // ---- subtitles & chapters -------------------------------------------------
    r.stage("subs", 0.87, 0.03, "Retiming subtitles and chapters");
    let timeline_changed = !cuts.is_empty();
    let mut sub_args: Vec<String> = Vec::new();
    let mut chapter_args: Vec<String> = Vec::new();
    if timeline_changed {
        for (i, s) in info.subtitles.iter().enumerate() {
            if !s.text {
                warnings.push(format!(
                    "Subtitle track {} ({}) is image based ({}) and was dropped because the timeline changed.",
                    i + 1,
                    s.language.clone().unwrap_or_else(|| "und".into()),
                    s.codec
                ));
                continue;
            }
            let (fmt, text) = match subs::extract_text(&tools, &source, s).await {
                Ok(x) => x,
                Err(e) => {
                    warnings.push(format!("Subtitle track {} could not be extracted and was dropped: {e}", i + 1));
                    continue;
                }
            };
            let re = if fmt == "ass" { subs::remap_ass(&text, &map) } else { subs::remap_srt(&text, &map) };
            let f = work.join(format!("sub-{i:02}.{fmt}"));
            std::fs::write(&f, re.as_bytes()).map_err(|e| e.to_string())?;
            sub_args.extend(["--language".into(), format!("0:{}", s.language.clone().unwrap_or_else(|| "und".into()))]);
            if let Some(t) = &s.title {
                sub_args.extend(["--track-name".into(), format!("0:{t}")]);
            }
            sub_args.extend(["--default-track-flag".into(), format!("0:{}", if s.default { "yes" } else { "no" })]);
            sub_args.extend(["--forced-display-flag".into(), format!("0:{}", if s.forced { "yes" } else { "no" })]);
            sub_args.push(f.display().to_string());
        }
        if !info.chapters.is_empty() {
            let mut xml = String::from("<?xml version=\"1.0\"?>\n<!DOCTYPE Chapters SYSTEM \"matroskachapters.dtd\">\n<Chapters><EditionEntry>\n");
            let mut any = false;
            for c in &info.chapters {
                if let Some(t) = map.map_time(c.start) {
                    any = true;
                    xml.push_str(&format!(
                        "<ChapterAtom><ChapterTimeStart>{}</ChapterTimeStart><ChapterDisplay><ChapterString>{}</ChapterString><ChapterLanguage>eng</ChapterLanguage></ChapterDisplay></ChapterAtom>\n",
                        chapter_time(t),
                        xml_escape(&c.title)
                    ));
                }
            }
            xml.push_str("</EditionEntry></Chapters>\n");
            if any {
                let f = work.join("chapters.xml");
                std::fs::write(&f, xml.as_bytes()).map_err(|e| e.to_string())?;
                chapter_args.extend(["--chapters".into(), f.display().to_string()]);
            }
        }
    }

    // ---- final mux --------------------------------------------------------------
    r.stage("mux", 0.90, 0.08, "Writing the final file");
    let final_mkv = if req.container == "mp4" { work.join("final.mkv") } else { PathBuf::from(&req.output) };
    let mut args: Vec<String> = vec!["-o".into(), final_mkv.display().to_string()];
    if let Some(t) = &info.title {
        args.extend(["--title".into(), t.clone()]);
    }
    args.extend(chapter_args);
    match &va {
        Some(va) => {
            // restore audio track names/languages (a card may be first in the chain)
            for (i, a) in info.audio.iter().enumerate() {
                let tid = i + 1;
                args.extend(["--language".into(), format!("{tid}:{}", a.language.clone().unwrap_or_else(|| "und".into()))]);
                if let Some(t) = &a.title {
                    args.extend(["--track-name".into(), format!("{tid}:{t}")]);
                }
                args.extend(["--default-track-flag".into(), format!("{tid}:{}", if a.default { "yes" } else { "no" })]);
            }
            args.extend(["--no-subtitles".into(), "--no-chapters".into(), va.display().to_string()]);
        }
        None => {
            args.extend(["--no-audio".into(), "--no-subtitles".into(), "--no-chapters".into(), "--no-global-tags".into(), video_src.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| src.clone())]);
            if !info.audio.is_empty() {
                args.extend(["--no-video".into(), "--no-subtitles".into(), "--no-chapters".into(), "--no-global-tags".into(), audio_src.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| src.clone())]);
            }
        }
    }
    if timeline_changed {
        args.extend(sub_args);
    } else if !info.subtitles.is_empty() || !info.chapters.is_empty() {
        // subtitles and chapters straight from the source, untouched
        args.extend(["--no-video".into(), "--no-audio".into(), "--no-global-tags".into(), src.clone()]);
    }
    r.mkvmerge(&args, 1.0).await?;

    if req.container == "mp4" {
        r.stage("mp4", 0.98, 0.02, "Repackaging as MP4 (stream copy)");
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.push(final_mkv.display().to_string());
        args.extend(["-map".into(), "0:v".into(), "-map".into(), "0:a?".into()]);
        let text_subs = info.subtitles.iter().any(|s| s.text);
        if text_subs {
            args.extend(["-map".into(), "0:s?".into(), "-c:s".into(), "mov_text".into()]);
        }
        args.extend(["-c:v".into(), "copy".into(), "-c:a".into(), "copy".into()]);
        if video.codec == "hevc" {
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
        args.extend(["-movflags".into(), "+faststart".into(), req.output.clone()]);
        r.ffmpeg(&args, None).await?;
    }

    let final_info = probe::probe(&tools, Path::new(&req.output)).await?;
    r.stage("done", 1.0, 0.0, "Done");
    Ok(RenderResult { output: req.output.clone(), duration: final_info.duration, original_duration, warnings: Vec::new(), applied, seconds_encoded })
}

fn append_args(out: &Path, chain: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec!["-o".into(), out.display().to_string()];
    for (i, f) in chain.iter().enumerate() {
        if i > 0 {
            args.push("+".into());
        }
        args.push(f.clone());
    }
    args
}

fn chapter_time(t: f64) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as i64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_spec_nudges_boundaries_before_keyframes() {
        let spec = parts_spec(&[(0.0, Some(54.458)), (216.708, None)]);
        assert_eq!(spec, "parts:0.0000s-54.4575s,216.7075s-");
    }
}
