import { fmtTime, newId, parseTime, type Edit, type EditKind } from "./types";

const ACTION_OUT: Record<EditKind, string> = {
  remove: "remove",
  replace: "replace",
  textOverVideo: "text-keep-audio",
  mute: "mute",
};
const ACTION_IN: Record<string, EditKind> = {
  remove: "remove",
  cut: "remove",
  delete: "remove",
  replace: "replace",
  card: "replace",
  "text-keep-audio": "textOverVideo",
  "text-over-video": "textOverVideo",
  textovervideo: "textOverVideo",
  text: "textOverVideo",
  mute: "mute",
  silence: "mute",
};

export const CSV_HEADER = "start,end,action,text,card_seconds,enabled";

function q(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Columns are always present; a dash marks a value that does not apply. */
export function editsToCsv(edits: Edit[]): string {
  const rows = [CSV_HEADER];
  for (const e of edits) {
    const text = e.kind === "replace" || e.kind === "textOverVideo" ? e.text : "-";
    const card = e.kind === "replace" ? (e.durationMode === "match" ? "match" : String(e.duration)) : e.kind === "textOverVideo" ? "match" : "-";
    rows.push([fmtTime(e.start), fmtTime(e.end), ACTION_OUT[e.kind], q(text), card, e.enabled ? "yes" : "no"].join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function csvToEdits(text: string, defaultCardSeconds: number): { edits: Edit[]; errors: string[] } {
  const edits: Edit[] = [];
  const errors: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { edits, errors: ["The file is empty."] };
  let startAt = 0;
  const first = parseCsvLine(lines[0]).map((s) => s.trim().toLowerCase());
  const cols = { start: 0, end: 1, action: 2, text: 3, card: 4, enabled: 5 };
  if (first.includes("start") || first.includes("action")) {
    startAt = 1;
    const idx = (names: string[], fallback: number) => {
      const i = first.findIndex((h) => names.includes(h));
      return i >= 0 ? i : fallback;
    };
    cols.start = idx(["start", "from", "begin"], 0);
    cols.end = idx(["end", "to", "finish", "stop"], 1);
    cols.action = idx(["action", "type", "kind"], 2);
    cols.text = idx(["text", "card", "message"], 3);
    cols.card = idx(["card_seconds", "duration", "card_duration", "seconds"], 4);
    cols.enabled = idx(["enabled", "on", "active"], 5);
  }
  for (let li = startAt; li < lines.length; li++) {
    const f = parseCsvLine(lines[li]);
    const get = (i: number) => (f[i] ?? "").trim();
    const start = parseTime(get(cols.start));
    const end = parseTime(get(cols.end));
    const kind = ACTION_IN[get(cols.action).toLowerCase()];
    if (start === null || end === null || !kind) {
      errors.push(`Line ${li + 1}: could not read start/end/action.`);
      continue;
    }
    if (end <= start) {
      errors.push(`Line ${li + 1}: end must be after start.`);
      continue;
    }
    const textRaw = get(cols.text);
    const text = textRaw === "-" ? "" : textRaw;
    const cardRaw = get(cols.card).toLowerCase();
    let durationMode: Edit["durationMode"] = "fixed";
    let duration = defaultCardSeconds;
    if (cardRaw === "match" || cardRaw === "original" || cardRaw === "same") durationMode = "match";
    else if (cardRaw && cardRaw !== "-" && !isNaN(Number(cardRaw))) duration = Number(cardRaw);
    const en = get(cols.enabled).toLowerCase();
    const enabled = !(en === "no" || en === "false" || en === "0" || en === "off");
    edits.push({ id: newId(), kind, start, end, text, durationMode, duration, enabled });
  }
  edits.sort((a, b) => a.start - b.start);
  return { edits, errors };
}
