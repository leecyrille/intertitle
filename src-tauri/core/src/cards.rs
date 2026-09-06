//! Title card rendering: pick encoders that match the source streams so the
//! card can be appended to stream-copied segments without re-encoding them.

use crate::probe::{AudioInfo, VideoInfo};
use crate::tools::filter_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardStyle {
    /// Path to a TTF/OTF file. Empty = platform default.
    pub font_file: String,
    /// Font size as a fraction of the video height (0.055 ≈ 120px at 2160p)
    pub font_size_ratio: f64,
    pub text_color: String,
    pub background_color: String,
    /// Fade in/out length in seconds (0 disables)
    pub fade: f64,
    /// libx264/libx265 preset used for the card
    pub preset: String,
}

impl Default for CardStyle {
    fn default() -> Self {
        CardStyle {
            font_file: String::new(),
            font_size_ratio: 0.055,
            text_color: "white".into(),
            background_color: "black".into(),
            fade: 0.75,
            preset: "fast".into(),
        }
    }
}

pub fn default_font() -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf"]
    } else if cfg!(target_os = "macos") {
        &["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
    };
    candidates.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Word-wrap so the longest line fits roughly within the frame width.
pub fn wrap_text(text: &str, max_chars: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    for para in text.replace("\r\n", "\n").split('\n') {
        if para.trim().is_empty() {
            out.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in para.split_whitespace() {
            if line.is_empty() {
                line = word.to_string();
            } else if line.chars().count() + 1 + word.chars().count() > max_chars {
                out.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line.push(' ');
                line.push_str(word);
            }
        }
        if !line.is_empty() {
            out.push(line);
        }
    }
    out.join("\n")
}

fn level_string(level: i64, codec: &str) -> Option<String> {
    if level <= 0 {
        return None;
    }
    match codec {
        "hevc" => Some(format!("{:.1}", level as f64 / 30.0)),
        "h264" => Some(format!("{:.1}", level as f64 / 10.0)),
        _ => None,
    }
}

fn is_10bit(pix: &str) -> bool {
    pix.contains("10")
}
fn is_12bit(pix: &str) -> bool {
    pix.contains("12")
}

/// ffmpeg output arguments that produce a video stream compatible with `v`.
pub fn video_encoder_args(v: &VideoInfo, style: &CardStyle) -> Result<Vec<String>, String> {
    let pix = v.pix_fmt.clone().unwrap_or_else(|| "yuv420p".into());
    let mut a: Vec<String> = Vec::new();
    let keyint = (v.fps() * 2.0).round().max(1.0) as i64;
    let mut color_params: Vec<String> = Vec::new();
    if let Some(p) = &v.color_primaries {
        color_params.push(format!("colorprim={p}"));
    }
    if let Some(t) = &v.color_transfer {
        color_params.push(format!("transfer={t}"));
    }
    if let Some(m) = &v.color_space {
        color_params.push(format!("colormatrix={m}"));
    }
    match v.codec.as_str() {
        "hevc" => {
            a.extend(["-c:v".into(), "libx265".into(), "-preset".into(), style.preset.clone(), "-crf".into(), "18".into()]);
            let profile = if is_12bit(&pix) { "main12" } else if is_10bit(&pix) { "main10" } else { "main" };
            a.extend(["-profile:v".into(), profile.into()]);
            let mut params = vec![format!("keyint={keyint}"), format!("min-keyint={}", keyint / 2), "repeat-headers=1".into(), "bframes=0".into()];
            if let Some(l) = v.level.and_then(|l| level_string(l, "hevc")) {
                params.push(format!("level-idc={l}"));
            }
            if let Some(r) = &v.color_range {
                params.push(format!("range={}", if r == "pc" { "full" } else { "limited" }));
            }
            if let Some(c) = &v.chroma_location {
                let loc = match c.as_str() {
                    "left" => "0",
                    "center" => "1",
                    "topleft" => "2",
                    "top" => "3",
                    "bottomleft" => "4",
                    "bottom" => "5",
                    _ => "0",
                };
                params.push(format!("chromaloc={loc}"));
            }
            params.extend(color_params.clone());
            a.extend(["-x265-params".into(), params.join(":")]);
        }
        "h264" => {
            a.extend(["-c:v".into(), "libx264".into(), "-preset".into(), style.preset.clone(), "-crf".into(), "18".into()]);
            let profile = if is_10bit(&pix) { "high10" } else if pix.contains("444") { "high444" } else if pix.contains("422") { "high422" } else { "high" };
            a.extend(["-profile:v".into(), profile.into()]);
            if let Some(l) = v.level.and_then(|l| level_string(l, "h264")) {
                a.extend(["-level:v".into(), l]);
            }
            let mut params = vec![format!("keyint={keyint}"), format!("min-keyint={}", keyint / 2), "bframes=0".into()];
            params.extend(color_params.clone());
            a.extend(["-x264-params".into(), params.join(":")]);
        }
        "av1" => {
            a.extend(["-c:v".into(), "libsvtav1".into(), "-preset".into(), "8".into(), "-crf".into(), "28".into(), "-g".into(), keyint.to_string()]);
        }
        "vp9" => {
            a.extend(["-c:v".into(), "libvpx-vp9".into(), "-crf".into(), "28".into(), "-b:v".into(), "0".into(), "-g".into(), keyint.to_string(), "-row-mt".into(), "1".into()]);
        }
        "vp8" => {
            a.extend(["-c:v".into(), "libvpx".into(), "-crf".into(), "12".into(), "-b:v".into(), "2M".into(), "-g".into(), keyint.to_string()]);
        }
        "mpeg4" => {
            a.extend(["-c:v".into(), "mpeg4".into(), "-q:v".into(), "3".into(), "-g".into(), keyint.to_string()]);
            if let Some(p) = &v.profile {
                if p.contains("Advanced") {
                    a.extend(["-profile:v".into(), "15".into()]);
                }
            }
        }
        "mpeg2video" => {
            a.extend(["-c:v".into(), "mpeg2video".into(), "-q:v".into(), "3".into(), "-g".into(), keyint.to_string()]);
        }
        "mpeg1video" => {
            a.extend(["-c:v".into(), "mpeg1video".into(), "-q:v".into(), "3".into(), "-g".into(), keyint.to_string()]);
        }
        "prores" => {
            a.extend(["-c:v".into(), "prores_ks".into(), "-profile:v".into(), "3".into()]);
        }
        "mjpeg" => {
            a.extend(["-c:v".into(), "mjpeg".into(), "-q:v".into(), "3".into()]);
        }
        "dnxhd" => {
            a.extend(["-c:v".into(), "dnxhd".into(), "-profile:v".into(), "dnxhr_hq".into()]);
        }
        other => {
            return Err(format!(
                "The video is encoded with '{other}', which ffmpeg cannot encode, so text cards cannot be inserted. Remove and Mute still work."
            ))
        }
    }
    a.extend(["-bf".into(), "0".into()]);
    a.extend(["-pix_fmt".into(), pix.clone()]);
    if let Some(r) = &v.color_range {
        a.extend(["-color_range".into(), r.clone()]);
    }
    if let Some(p) = &v.color_primaries {
        a.extend(["-color_primaries".into(), p.clone()]);
    }
    if let Some(t) = &v.color_transfer {
        a.extend(["-color_trc".into(), t.clone()]);
    }
    if let Some(m) = &v.color_space {
        a.extend(["-colorspace".into(), m.clone()]);
    }
    if let Some(c) = &v.chroma_location {
        a.extend(["-chroma_sample_location".into(), c.clone()]);
    }
    Ok(a)
}

/// ffmpeg output arguments for one silent audio stream that matches `au`.
pub fn audio_encoder_args(au: &AudioInfo, out_idx: usize) -> Result<Vec<String>, String> {
    let spec = format!("a:{out_idx}");
    let mut a: Vec<String> = Vec::new();
    let br = au.bit_rate.map(|b| b.to_string());
    let mut set = |codec: &str, extra: &[&str]| {
        a.extend([format!("-c:{spec}"), codec.into()]);
        for e in extra {
            a.push(e.to_string());
        }
    };
    match au.codec.as_str() {
        "aac" => set("aac", &[]),
        "ac3" => set("ac3", &[]),
        "eac3" => set("eac3", &[]),
        "dts" => set("dca", &["-strict", "-2"]),
        "truehd" => set("truehd", &["-strict", "-2"]),
        "mlp" => set("mlp", &["-strict", "-2"]),
        "mp3" => set("libmp3lame", &[]),
        "mp2" => set("mp2", &[]),
        "opus" => set("libopus", &[]),
        "vorbis" => set("libvorbis", &[]),
        "flac" => set("flac", &[]),
        "alac" => set("alac", &[]),
        "wmav2" => set("wmav2", &[]),
        "wmav1" => set("wmav1", &[]),
        c if c.starts_with("pcm_") => set(c, &[]),
        other => return Err(format!("Silent audio cannot be generated for codec '{other}'.")),
    }
    if let Some(b) = br {
        if !matches!(au.codec.as_str(), "flac" | "alac" | "truehd" | "mlp") && !au.codec.starts_with("pcm_") {
            a.extend([format!("-b:{spec}"), b]);
        }
    }
    a.extend([format!("-ar:{spec}"), au.sample_rate.to_string()]);
    a.extend([format!("-ac:{spec}"), au.channels.to_string()]);
    Ok(a)
}

/// Channel layout string for anullsrc.
fn layout_for(au: &AudioInfo) -> String {
    match &au.channel_layout {
        Some(l) => l.clone(),
        None => match au.channels {
            1 => "mono".into(),
            2 => "stereo".into(),
            6 => "5.1".into(),
            8 => "7.1".into(),
            n => format!("{n}c"),
        },
    }
}

pub struct CardSpec<'a> {
    pub video: &'a VideoInfo,
    /// audio tracks to include (silent); empty for a video-only card
    pub audio: &'a [AudioInfo],
    pub text: &'a str,
    pub frames: i64,
    pub style: &'a CardStyle,
    pub out: &'a Path,
    pub work_dir: &'a Path,
}

/// Build the ffmpeg argument list that renders a card.
pub fn card_args(spec: &CardSpec) -> Result<Vec<String>, String> {
    let v = spec.video;
    let fps = v.fps();
    let duration = spec.frames as f64 / fps;
    let font = if spec.style.font_file.trim().is_empty() {
        default_font().ok_or("No font found for the title card. Set a font file in Settings.")?
    } else {
        PathBuf::from(spec.style.font_file.trim())
    };
    let font_size = ((v.height as f64) * spec.style.font_size_ratio).round().max(12.0) as i64;
    // approx average glyph width ≈ 0.5 em; keep lines within ~80% of the frame
    let max_chars = (((v.width as f64) * 0.8) / (font_size as f64 * 0.52)).floor().max(10.0) as usize;
    let wrapped = wrap_text(spec.text, max_chars);
    let text_file = spec.work_dir.join(format!("card-{}.txt", spec.frames));
    std::fs::write(&text_file, wrapped.as_bytes()).map_err(|e| e.to_string())?;

    let fade = spec.style.fade.max(0.0).min(duration / 2.0);
    let alpha = if fade > 0.0 {
        format!("if(lt(t\\,{f}),t/{f},if(gt(t\\,{d}-{f}),({d}-t)/{f},1))", f = fade, d = duration)
    } else {
        "1".into()
    };
    let vf = format!(
        "drawtext=fontfile={}:textfile={}:text_align=M+C:fontcolor={}:fontsize={}:line_spacing={}:x=(w-text_w)/2:y=(h-text_h)/2:alpha='{}',setsar=1,format={}",
        filter_path(&font),
        filter_path(&text_file),
        spec.style.text_color,
        font_size,
        font_size / 4,
        alpha,
        v.pix_fmt.clone().unwrap_or_else(|| "yuv420p".into())
    );
    let fps_str = if v.fps_den == 1 { v.fps_num.to_string() } else { format!("{}/{}", v.fps_num, v.fps_den) };
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into(), "-progress".into(), "pipe:1".into(), "-nostats".into()];
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("color=c={}:s={}x{}:r={}", spec.style.background_color, v.width, v.height, fps_str),
    ]);
    for au in spec.audio {
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("anullsrc=r={}:cl={}", au.sample_rate, layout_for(au))]);
    }
    args.extend(["-map".into(), "0:v".into()]);
    for (i, _) in spec.audio.iter().enumerate() {
        args.extend(["-map".into(), format!("{}:a", i + 1)]);
    }
    args.extend(["-frames:v".into(), spec.frames.to_string(), "-t".into(), format!("{duration:.6}")]);
    args.extend(["-vf".into(), vf]);
    args.extend(video_encoder_args(v, spec.style)?);
    for (i, au) in spec.audio.iter().enumerate() {
        args.extend(audio_encoder_args(au, i)?);
    }
    args.push(spec.out.display().to_string());
    Ok(args)
}

/// Arguments for a silence-only file (used by Mute), matching all given tracks.
pub fn silence_args(audio: &[AudioInfo], duration: f64, out: &Path) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    for au in audio {
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("anullsrc=r={}:cl={}", au.sample_rate, layout_for(au))]);
    }
    for i in 0..audio.len() {
        args.extend(["-map".into(), format!("{i}:a")]);
    }
    args.extend(["-t".into(), format!("{duration:.6}")]);
    for (i, au) in audio.iter().enumerate() {
        args.extend(audio_encoder_args(au, i)?);
    }
    args.push(out.display().to_string());
    Ok(args)
}

