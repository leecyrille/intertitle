//! The edit-list CSV format shared by the app and the CLI.
//!
//! ```text
//! start,end,action,text,card_seconds,enabled
//! 00:00:55.000,00:03:36.000,replace,"He just woke up.",10,yes
//! 01:54:58.000,01:55:35.000,remove,-,-,yes
//! ```
//! Times accept `H:MM:SS.mmm`, `MM:SS` or plain seconds. A dash marks a value
//! that does not apply. `card_seconds` may be a number or `match`.

use crate::pipeline::{DurationMode, Edit, EditKind};
use crate::subs::{fmt_srt_time, parse_srt_time};

fn split_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_q {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cur.push('"');
                    i += 1;
                } else {
                    in_q = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_q = true;
        } else if c == ',' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
        i += 1;
    }
    out.push(cur);
    out
}

fn kind_from(s: &str) -> Option<EditKind> {
    Some(match s.trim().to_ascii_lowercase().as_str() {
        "remove" | "cut" | "delete" => EditKind::Remove,
        "replace" | "card" => EditKind::Replace,
        "text-keep-audio" | "text-over-video" | "textovervideo" | "text" => EditKind::TextOverVideo,
        "mute" | "silence" => EditKind::Mute,
        _ => return None,
    })
}

pub fn kind_name(k: &EditKind) -> &'static str {
    match k {
        EditKind::Remove => "remove",
        EditKind::Replace => "replace",
        EditKind::TextOverVideo => "text-keep-audio",
        EditKind::Mute => "mute",
    }
}

/// Parse a CSV edit list. Returns the edits (sorted by start) and any per-line problems.
pub fn parse_csv(text: &str, default_card_seconds: f64) -> (Vec<Edit>, Vec<String>) {
    let mut edits = Vec::new();
    let mut errors = Vec::new();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return (edits, vec!["The file is empty.".into()]);
    }
    let mut cols = [0usize, 1, 2, 3, 4, 5];
    let mut start_at = 0;
    let header: Vec<String> = split_csv_line(lines[0]).iter().map(|h| h.trim().to_ascii_lowercase()).collect();
    if header.iter().any(|h| h == "start" || h == "action") {
        start_at = 1;
        let idx = |names: &[&str], fallback: usize| header.iter().position(|h| names.contains(&h.as_str())).unwrap_or(fallback);
        cols = [
            idx(&["start", "from", "begin"], 0),
            idx(&["end", "to", "finish", "stop"], 1),
            idx(&["action", "type", "kind"], 2),
            idx(&["text", "card", "message"], 3),
            idx(&["card_seconds", "duration", "card_duration", "seconds"], 4),
            idx(&["enabled", "on", "active"], 5),
        ];
    }
    for (li, line) in lines.iter().enumerate().skip(start_at) {
        let f = split_csv_line(line);
        let get = |i: usize| f.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
        let (start, end, kind) = (parse_srt_time(&get(cols[0])), parse_srt_time(&get(cols[1])), kind_from(&get(cols[2])));
        let (Some(start), Some(end), Some(kind)) = (start, end, kind) else {
            errors.push(format!("Line {}: could not read start/end/action.", li + 1));
            continue;
        };
        if end <= start {
            errors.push(format!("Line {}: end must be after start.", li + 1));
            continue;
        }
        let text_raw = get(cols[3]);
        let text = if text_raw == "-" { String::new() } else { text_raw };
        let card = get(cols[4]).to_ascii_lowercase();
        let (duration_mode, duration) = match card.as_str() {
            "match" | "original" | "same" => (DurationMode::Match, default_card_seconds),
            "" | "-" => (DurationMode::Fixed, default_card_seconds),
            n => (DurationMode::Fixed, n.parse::<f64>().unwrap_or(default_card_seconds)),
        };
        let en = get(cols[5]).to_ascii_lowercase();
        let enabled = !matches!(en.as_str(), "no" | "false" | "0" | "off");
        edits.push(Edit { id: format!("csv{}", li + 1), kind, start, end, text, duration_mode, duration, enabled });
    }
    edits.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    (edits, errors)
}

fn q(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Serialize edits in the same CSV layout the app exports (dashes for N/A).
pub fn to_csv(edits: &[Edit]) -> String {
    let mut out = String::from("start,end,action,text,card_seconds,enabled\r\n");
    for e in edits {
        let has_text = matches!(e.kind, EditKind::Replace | EditKind::TextOverVideo);
        let text = if has_text { e.text.as_str() } else { "-" };
        let card = match e.kind {
            EditKind::Replace => match e.duration_mode {
                DurationMode::Match => "match".to_string(),
                DurationMode::Fixed => format!("{}", e.duration),
            },
            EditKind::TextOverVideo => "match".into(),
            _ => "-".into(),
        };
        out.push_str(&format!(
            "{},{},{},{},{},{}\r\n",
            fmt_srt_time(e.start).replace(',', "."),
            fmt_srt_time(e.end).replace(',', "."),
            kind_name(&e.kind),
            q(text),
            card,
            if e.enabled { "yes" } else { "no" }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_roundtrips() {
        let csv = "start,end,action,text,card_seconds,enabled\r\n00:00:55.000,00:03:36.000,replace,\"He woke up, confused\",10,yes\r\n1:54:58,1:55:35,remove,-,-,no\r\n10:00,10:05,mute,-,-,yes\r\n";
        let (edits, errors) = parse_csv(csv, 10.0);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(edits.len(), 3);
        assert_eq!(edits[0].kind, EditKind::Replace);
        assert_eq!(edits[0].text, "He woke up, confused");
        assert_eq!(edits[1].kind, EditKind::Mute);
        assert!(!edits[2].enabled);
        let again = parse_csv(&to_csv(&edits), 10.0).0;
        assert_eq!(again.len(), 3);
        assert_eq!(again[2].start, 6898.0);
    }

    #[test]
    fn headerless_and_bad_lines() {
        let (edits, errors) = parse_csv("00:10,00:20,cut\nnonsense\n", 10.0);
        assert_eq!(edits.len(), 1);
        assert_eq!(errors.len(), 1);
    }
}
