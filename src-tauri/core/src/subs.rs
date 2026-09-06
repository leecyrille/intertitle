//! Subtitle extraction and retiming (SRT and ASS/SSA).

use crate::probe::SubInfo;
use crate::timeline::TimelineMap;
use crate::tools::{run_capture, Tools};
use std::path::Path;

/// Extract a text subtitle stream. Returns (format, text) where format is "srt" or "ass".
pub async fn extract_text(tools: &Tools, path: &Path, sub: &SubInfo) -> Result<(String, String), String> {
    let (fmt, codec) = match sub.codec.as_str() {
        "ass" | "ssa" => ("ass", "copy"),
        "subrip" | "srt" => ("srt", "copy"),
        "webvtt" | "mov_text" | "text" => ("srt", "subrip"),
        other => return Err(format!("Subtitle format '{other}' is not text based and cannot be previewed or retimed.")),
    };
    let map = format!("0:{}", sub.index);
    let out = run_capture(
        &tools.ffmpeg,
        &["-hide_banner", "-loglevel", "error", "-i", &path.display().to_string(), "-map", &map, "-c:s", codec, "-f", fmt, "-"],
    )
    .await?;
    Ok((fmt.to_string(), out))
}

// ---------- time formatting ----------

pub fn parse_srt_time(t: &str) -> Option<f64> {
    let t = t.trim().replace(',', ".");
    let parts: Vec<&str> = t.split(':').collect();
    let mut secs = 0.0;
    for p in &parts {
        secs = secs * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    Some(secs)
}

pub fn fmt_srt_time(s: f64) -> String {
    let s = s.max(0.0);
    let ms = ((s * 1000.0).round() as i64).max(0);
    let h = ms / 3_600_000;
    let m = (ms / 60_000) % 60;
    let sec = (ms / 1000) % 60;
    let milli = ms % 1000;
    format!("{h:02}:{m:02}:{sec:02},{milli:03}")
}

pub fn fmt_ass_time(s: f64) -> String {
    let cs = ((s.max(0.0) * 100.0).round() as i64).max(0);
    let h = cs / 360_000;
    let m = (cs / 6000) % 60;
    let sec = (cs / 100) % 60;
    let c = cs % 100;
    format!("{h}:{m:02}:{sec:02}.{c:02}")
}

/// Retime an SRT document through the timeline map. Cues that start inside a removed range are dropped.
pub fn remap_srt(text: &str, map: &TimelineMap) -> String {
    let norm = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    let mut n = 0;
    for block in norm.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        // find the timing line (usually the 2nd; some files omit the index)
        let Some(tpos) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let timing = lines[tpos];
        let Some((a, rest)) = timing.split_once("-->") else { continue };
        let mut rest_it = rest.trim().splitn(2, char::is_whitespace);
        let b = rest_it.next().unwrap_or("");
        let extra = rest_it.next().map(|x| format!(" {x}")).unwrap_or_default();
        let (Some(sa), Some(sb)) = (parse_srt_time(a), parse_srt_time(b)) else { continue };
        let Some((na, nb)) = map.map_range(sa, sb) else { continue };
        n += 1;
        out.push_str(&format!("{n}\n{} --> {}{}\n", fmt_srt_time(na), fmt_srt_time(nb), extra));
        for l in &lines[tpos + 1..] {
            out.push_str(l);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

/// Retime an ASS/SSA document: only "Dialogue:" lines carry timestamps.
pub fn remap_ass(text: &str, map: &TimelineMap) -> String {
    let mut out = String::new();
    for line in text.replace("\r\n", "\n").lines() {
        if let Some(rest) = line.strip_prefix("Dialogue:") {
            let fields: Vec<&str> = rest.splitn(10, ',').collect();
            if fields.len() >= 3 {
                if let (Some(sa), Some(sb)) = (parse_srt_time(fields[1]), parse_srt_time(fields[2])) {
                    if let Some((na, nb)) = map.map_range(sa, sb) {
                        let mut f2: Vec<String> = fields.iter().map(|x| x.to_string()).collect();
                        f2[1] = fmt_ass_time(na);
                        f2[2] = fmt_ass_time(nb);
                        out.push_str("Dialogue:");
                        out.push_str(&f2.join(","));
                        out.push('\n');
                    }
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::Piece;

    #[test]
    fn srt_roundtrip_and_drop() {
        let map = TimelineMap::new(vec![
            Piece::Kept { src_start: 0.0, src_end: 10.0, dur: 10.0 },
            Piece::Card { dur: 5.0 },
            Piece::Kept { src_start: 20.0, src_end: 30.0, dur: 10.0 },
        ]);
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:12,000 --> 00:00:13,000\ngone\n\n3\n00:00:21,500 --> 00:00:22,000\nback\n";
        let out = remap_srt(srt, &map);
        assert!(out.contains("00:00:01,000 --> 00:00:02,000"));
        assert!(!out.contains("gone"));
        assert!(out.contains("00:00:16,500 --> 00:00:17,000"));
    }

    #[test]
    fn ass_time_format() {
        assert_eq!(fmt_ass_time(3661.25), "1:01:01.25");
    }
}
