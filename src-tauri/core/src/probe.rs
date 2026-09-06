//! ffprobe wrappers: media information and keyframe lookup.

use crate::tools::{run_capture, Tools};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub index: usize,
    pub codec: String,
    pub profile: Option<String>,
    pub level: Option<i64>,
    pub width: i64,
    pub height: i64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub pix_fmt: Option<String>,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub chroma_location: Option<String>,
    pub sar: Option<String>,
    pub field_order: Option<String>,
    pub bit_rate: Option<i64>,
    pub nb_frames: Option<i64>,
}

impl VideoInfo {
    pub fn fps(&self) -> f64 {
        if self.fps_den == 0 {
            24.0
        } else {
            self.fps_num as f64 / self.fps_den as f64
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub index: usize,
    pub codec: String,
    pub profile: Option<String>,
    pub channels: i64,
    pub channel_layout: Option<String>,
    pub sample_rate: i64,
    pub bit_rate: Option<i64>,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubInfo {
    pub index: usize,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    pub forced: bool,
    /// true for text based formats we can retime (subrip, ass, ssa, webvtt, mov_text)
    pub text: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub start: f64,
    pub end: f64,
    pub title: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub file_name: String,
    pub container: String,
    pub duration: f64,
    pub size: u64,
    pub title: Option<String>,
    pub video: Option<VideoInfo>,
    pub audio: Vec<AudioInfo>,
    pub subtitles: Vec<SubInfo>,
    pub chapters: Vec<Chapter>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string()).filter(|x| !x.is_empty() && x != "unknown")
}
fn i(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| match x {
        Value::Number(n) => n.as_i64(),
        Value::String(st) => st.parse::<i64>().ok(),
        _ => None,
    })
}
fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| match x {
        Value::Number(n) => n.as_f64(),
        Value::String(st) => st.parse::<f64>().ok(),
        _ => None,
    })
}
fn tag(v: &Value, key: &str) -> Option<String> {
    v.get("tags").and_then(|t| {
        t.get(key)
            .or_else(|| t.get(&key.to_uppercase()))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string())
    })
}
fn disp(v: &Value, key: &str) -> bool {
    v.get("disposition").and_then(|d| d.get(key)).and_then(|x| x.as_i64()).unwrap_or(0) == 1
}
fn parse_ratio(r: &str) -> Option<(i64, i64)> {
    let mut it = r.split('/');
    let a = it.next()?.parse::<i64>().ok()?;
    let b = it.next()?.parse::<i64>().ok()?;
    if b == 0 {
        None
    } else {
        Some((a, b))
    }
}

pub async fn probe(tools: &Tools, path: &Path) -> Result<MediaInfo, String> {
    let out = run_capture(
        &tools.ffprobe,
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            &path.display().to_string(),
        ],
    )
    .await?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("ffprobe output could not be parsed: {e}"))?;
    let format = v.get("format").cloned().unwrap_or(Value::Null);
    let mut info = MediaInfo {
        path: path.display().to_string(),
        file_name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        container: s(&format, "format_name").unwrap_or_default(),
        duration: f(&format, "duration").unwrap_or(0.0),
        size: i(&format, "size").unwrap_or(0) as u64,
        title: tag(&format, "title"),
        ..Default::default()
    };
    let streams = v.get("streams").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    for st in streams {
        let index = i(&st, "index").unwrap_or(0) as usize;
        let codec = s(&st, "codec_name").unwrap_or_else(|| "unknown".into());
        match s(&st, "codec_type").as_deref() {
            Some("video") => {
                // skip cover art / attached pictures
                if disp(&st, "attached_pic") {
                    continue;
                }
                if info.video.is_some() {
                    continue;
                }
                let avg = s(&st, "avg_frame_rate").and_then(|r| parse_ratio(&r));
                let rfr = s(&st, "r_frame_rate").and_then(|r| parse_ratio(&r));
                let (fps_num, fps_den) = avg.filter(|(a, _)| *a > 0).or(rfr).unwrap_or((24, 1));
                info.video = Some(VideoInfo {
                    index,
                    codec,
                    profile: s(&st, "profile"),
                    level: i(&st, "level"),
                    width: i(&st, "width").unwrap_or(0),
                    height: i(&st, "height").unwrap_or(0),
                    fps_num,
                    fps_den,
                    pix_fmt: s(&st, "pix_fmt"),
                    color_range: s(&st, "color_range"),
                    color_space: s(&st, "color_space"),
                    color_transfer: s(&st, "color_transfer"),
                    color_primaries: s(&st, "color_primaries"),
                    chroma_location: s(&st, "chroma_location"),
                    sar: s(&st, "sample_aspect_ratio"),
                    field_order: s(&st, "field_order"),
                    bit_rate: i(&st, "bit_rate"),
                    nb_frames: i(&st, "nb_frames").or_else(|| tag(&st, "NUMBER_OF_FRAMES").and_then(|x| x.parse().ok())),
                });
            }
            Some("audio") => info.audio.push(AudioInfo {
                index,
                codec,
                profile: s(&st, "profile"),
                channels: i(&st, "channels").unwrap_or(2),
                channel_layout: s(&st, "channel_layout"),
                sample_rate: i(&st, "sample_rate").unwrap_or(48000),
                bit_rate: i(&st, "bit_rate"),
                language: tag(&st, "language"),
                title: tag(&st, "title"),
                default: disp(&st, "default"),
            }),
            Some("subtitle") => {
                let text = matches!(codec.as_str(), "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text");
                info.subtitles.push(SubInfo {
                    index,
                    codec,
                    language: tag(&st, "language"),
                    title: tag(&st, "title"),
                    default: disp(&st, "default"),
                    forced: disp(&st, "forced"),
                    text,
                })
            }
            _ => {}
        }
    }
    if let Some(ch) = v.get("chapters").and_then(|x| x.as_array()) {
        for c in ch {
            info.chapters.push(Chapter {
                start: f(c, "start_time").unwrap_or(0.0),
                end: f(c, "end_time").unwrap_or(0.0),
                title: tag(c, "title").unwrap_or_default(),
            });
        }
    }
    if info.duration <= 0.0 {
        return Err("Could not determine the duration of this file.".into());
    }
    Ok(info)
}

/// Keyframe presentation timestamps of the first video stream within [from, to].
pub async fn keyframes_between(tools: &Tools, path: &Path, from: f64, to: f64) -> Result<Vec<f64>, String> {
    let from = from.max(0.0);
    if to <= from {
        return Ok(vec![]);
    }
    let interval = format!("{:.3}%{:.3}", from, to);
    let out = run_capture(
        &tools.ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,dts_time,flags",
            "-read_intervals",
            &interval,
            "-of",
            "csv=p=0",
            &path.display().to_string(),
        ],
    )
    .await?;
    let mut kf: Vec<f64> = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 3 || !parts[2].contains('K') {
            continue;
        }
        let pts = parts[0].parse::<f64>().ok().or_else(|| parts[1].parse::<f64>().ok());
        if let Some(p) = pts {
            if p >= from - 0.0005 && p <= to + 0.0005 {
                kf.push(p);
            }
        }
    }
    kf.sort_by(|a, b| a.partial_cmp(b).unwrap());
    kf.dedup();
    Ok(kf)
}

/// Nearest keyframe to `t` (either side), searching progressively wider windows.
pub async fn nearest_keyframe(tools: &Tools, path: &Path, t: f64, duration: f64) -> Result<f64, String> {
    if t <= 0.05 {
        return Ok(0.0);
    }
    for window in [15.0, 60.0, 300.0] {
        let kf = keyframes_between(tools, path, t - window, (t + window).min(duration)).await?;
        if let Some(best) = kf.iter().min_by(|a, b| (*a - t).abs().partial_cmp(&(*b - t).abs()).unwrap()) {
            return Ok(*best);
        }
    }
    Err(format!("No keyframe found near {t:.2}s"))
}
