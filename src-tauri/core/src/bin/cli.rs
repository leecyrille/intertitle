//! intertitle-cli: render an edit list from the command line, no GUI needed.
//!
//!   intertitle-cli MOVIE --edits list.csv [--out OUT] [--mp4] [--keep-temp]
//!   intertitle-cli MOVIE --remove 1:02:15-1:03:00 --mute 10:00-10:05 \
//!                        --card 20:00-21:00 "Rocky saved him" --text 30:00-30:10 "They slept" [--out OUT]
//!   intertitle-cli MOVIE --probe

use intertitle_core::cards::CardStyle;
use intertitle_core::editlist;
use intertitle_core::pipeline::{self, DurationMode, Edit, EditKind, RenderRequest, Runner};
use intertitle_core::preview;
use intertitle_core::probe;
use intertitle_core::subs::parse_srt_time;
use intertitle_core::tools::{ToolPaths, Tools};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Arc;

const USAGE: &str = "intertitle-cli MOVIE [--edits list.csv] [--remove A-B] [--mute A-B] [--card A-B TEXT] [--text A-B TEXT]
                     [--card-seconds N | --match] [--out FILE] [--mp4] [--keep-temp] [--probe] [--quiet]

  --edits FILE      CSV edit list (start,end,action,text,card_seconds,enabled)
  --remove A-B      cut the range out
  --mute A-B        silence the range
  --card A-B TEXT   replace the range with a title card (length: --card-seconds, default 10, or --match)
  --text A-B TEXT   keep the audio, replace the picture with a title card
  --out FILE        output path (default: next to the movie, ' (edited)' suffix)
  --mp4             write MP4 instead of MKV
  --probe           print stream information and exit
  --frame T FILE    save the frame at time T as a JPEG (preview helper)
  --clip A-B FILE   save a small H.264/AAC proxy of the range as MP4 (preview helper)
Times: H:MM:SS.mmm, MM:SS or seconds.";

fn parse_range(s: &str) -> Result<(f64, f64), String> {
    let (a, b) = s.split_once('-').ok_or_else(|| format!("range '{s}' must look like START-END"))?;
    let (a, b) = (parse_srt_time(a).ok_or_else(|| format!("bad time '{a}'"))?, parse_srt_time(b).ok_or_else(|| format!("bad time '{b}'"))?);
    if b <= a {
        return Err(format!("range '{s}': end must be after start"));
    }
    Ok((a, b))
}

#[tokio::main]
async fn main() {
    if let Err(e) = real_main().await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn real_main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let mut movie: Option<String> = None;
    let mut edits: Vec<Edit> = Vec::new();
    let mut out: Option<String> = None;
    let mut mp4 = false;
    let mut keep_temp = false;
    let mut do_probe = false;
    let mut frame: Option<(f64, String)> = None;
    let mut clip: Option<(f64, f64, String)> = None;
    let mut quiet = false;
    let mut card_seconds = 10.0;
    let mut match_len = false;
    let mut n = 0;
    let mut i = 0;
    let next = |i: &mut usize, what: &str| -> Result<String, String> {
        *i += 1;
        args.get(*i).cloned().ok_or_else(|| format!("{what} needs a value"))
    };
    while i < args.len() {
        let a = args[i].as_str();
        let mut push = |kind: EditKind, range: &str, text: String| -> Result<(), String> {
            let (s, e) = parse_range(range)?;
            n += 1;
            edits.push(Edit { id: format!("arg{n}"), kind, start: s, end: e, text, duration_mode: if match_len { DurationMode::Match } else { DurationMode::Fixed }, duration: card_seconds, enabled: true });
            Ok(())
        };
        match a {
            "--edits" => {
                let f = next(&mut i, a)?;
                let text = std::fs::read_to_string(&f).map_err(|e| format!("{f}: {e}"))?;
                let (list, errors) = editlist::parse_csv(&text, card_seconds);
                for e in errors {
                    eprintln!("warning: {e}");
                }
                edits.extend(list);
            }
            "--remove" => {
                let r = next(&mut i, a)?;
                push(EditKind::Remove, &r, String::new())?
            }
            "--mute" => {
                let r = next(&mut i, a)?;
                push(EditKind::Mute, &r, String::new())?
            }
            "--card" => {
                let r = next(&mut i, a)?;
                let t = next(&mut i, a)?;
                push(EditKind::Replace, &r, t)?
            }
            "--text" => {
                let r = next(&mut i, a)?;
                let t = next(&mut i, a)?;
                push(EditKind::TextOverVideo, &r, t)?
            }
            "--card-seconds" => card_seconds = next(&mut i, a)?.parse().map_err(|_| "--card-seconds needs a number")?,
            "--match" => match_len = true,
            "--out" => out = Some(next(&mut i, a)?),
            "--mp4" => mp4 = true,
            "--keep-temp" => keep_temp = true,
            "--probe" => do_probe = true,
            "--frame" => {
                let t = next(&mut i, a)?;
                let f = next(&mut i, a)?;
                frame = Some((parse_srt_time(&t).ok_or_else(|| format!("bad time '{t}'"))?, f));
            }
            "--clip" => {
                let r = next(&mut i, a)?;
                let f = next(&mut i, a)?;
                let (s, e) = parse_range(&r)?;
                clip = Some((s, e - s, f));
            }
            "--quiet" => quiet = true,
            _ if a.starts_with("--") => return Err(format!("unknown option {a}\n{USAGE}")),
            _ => movie = Some(a.to_string()),
        }
        i += 1;
    }
    let movie = movie.ok_or_else(|| format!("no movie given\n{USAGE}"))?;
    // --match / --card-seconds apply to every card no matter where they appear on the command line
    for e in edits.iter_mut().filter(|e| e.id.starts_with("arg") && e.kind == EditKind::Replace) {
        e.duration_mode = if match_len { DurationMode::Match } else { DurationMode::Fixed };
        e.duration = card_seconds;
    }
    let tools = Tools::resolve(&ToolPaths::default())?;

    if do_probe {
        let info = probe::probe(&tools, Path::new(&movie)).await?;
        println!("{}", serde_json::to_string_pretty(&info).unwrap());
        return Ok(());
    }
    if let Some((t, file)) = frame {
        let b64 = preview::frame_jpeg(&tools, Path::new(&movie), t, 1280, true).await?;
        std::fs::write(&file, decode_b64(&b64)?).map_err(|e| e.to_string())?;
        println!("wrote {file}");
        return Ok(());
    }
    if let Some((start, dur, file)) = clip {
        let info = probe::probe(&tools, Path::new(&movie)).await?;
        let audio = info.audio.iter().find(|a| a.default).or(info.audio.first()).map(|a| a.index);
        let b64 = preview::proxy_clip(&tools, Path::new(&movie), start, dur, 360, audio).await?;
        std::fs::write(&file, decode_b64(&b64)?).map_err(|e| e.to_string())?;
        println!("wrote {file}");
        return Ok(());
    }
    if edits.is_empty() {
        return Err(format!("no edits given\n{USAGE}"));
    }
    let output = out.unwrap_or_else(|| {
        let p = Path::new(&movie);
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "output".into());
        p.with_file_name(format!("{stem} (edited).{}", if mp4 { "mp4" } else { "mkv" })).display().to_string()
    });

    let on_progress: pipeline::ProgressFn = Arc::new(move |p| {
        if !quiet {
            eprint!("\r{:>5.1}%  {:<60}", p.percent, p.message);
            let _ = std::io::stderr().flush();
        }
    });
    let on_log: pipeline::LogFn = Arc::new(move |line: &str| {
        if !quiet && (line.starts_with("> ") || line.contains("Warning") || line.contains("Error")) {
            eprintln!("\n{line}");
        }
    });
    let mut runner = Runner::new(tools, Arc::new(AtomicBool::new(false)), Arc::new(AtomicU32::new(0)), on_progress, on_log);
    let req = RenderRequest { path: movie, edits, output: output.clone(), container: if mp4 { "mp4".into() } else { "mkv".into() }, style: CardStyle::default(), keep_temp };
    let res = pipeline::run(&mut runner, req).await?;
    if !quiet {
        eprintln!();
    }
    println!("{}", serde_json::to_string_pretty(&res).unwrap());
    Ok(())
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| e.to_string())
}
