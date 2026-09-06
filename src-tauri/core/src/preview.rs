//! Preview helpers: single frames, thumbnail strips and short playable proxies.

use crate::tools::{run_capture_bytes, Tools};
use base64::Engine;
use std::path::Path;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// One JPEG frame at `time`, scaled to `width` px wide.
/// `accurate` decodes from the previous keyframe to the exact frame (slower on 4K);
/// otherwise the nearest preceding keyframe is returned, which is instant.
pub async fn frame_jpeg(tools: &Tools, path: &Path, time: f64, width: i64, accurate: bool) -> Result<String, String> {
    let t = format!("{:.3}", time.max(0.0));
    let vf = format!("scale={}:-2:flags=fast_bilinear,format=yuv420p", width.max(64));
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    if !accurate {
        args.push("-noaccurate_seek".into());
    }
    args.extend([
        "-ss".into(),
        t,
        "-i".into(),
        path.display().to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf,
        "-f".into(),
        "image2pipe".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-q:v".into(),
        "4".into(),
        "-".into(),
    ]);
    let bytes = run_capture_bytes(&tools.ffmpeg, &args).await?;
    if bytes.is_empty() {
        return Err("ffmpeg produced no frame at that position".into());
    }
    Ok(b64(&bytes))
}

/// A short fragmented-MP4 proxy (H.264 + AAC stereo) that a web view can play.
pub async fn proxy_clip(
    tools: &Tools,
    path: &Path,
    start: f64,
    duration: f64,
    height: i64,
    audio_stream_index: Option<usize>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{:.3}", start.max(0.0)),
        "-i".into(),
        path.display().to_string(),
        "-t".into(),
        format!("{:.3}", duration.max(0.5)),
        "-map".into(),
        "0:v:0".into(),
    ];
    if let Some(ai) = audio_stream_index {
        args.extend(["-map".into(), format!("0:{ai}")]);
    }
    args.extend([
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        format!("scale=-2:{}:flags=fast_bilinear,format=yuv420p", height.max(144)),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-tune".into(),
        "zerolatency".into(),
        "-crf".into(),
        "27".into(),
        "-g".into(),
        "48".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        "-".into(),
    ]);
    let bytes = run_capture_bytes(&tools.ffmpeg, &args).await?;
    Ok(b64(&bytes))
}
