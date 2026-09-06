import { parseTime } from "./types";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function stripTags(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, "") // ASS override tags
    .replace(/<[^>]+>/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, rest] = lines[ti].split("-->");
    const bStr = (rest ?? "").trim().split(/\s+/)[0] ?? "";
    const start = parseTime(a);
    const end = parseTime(bStr);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: stripTags(lines.slice(ti + 1).join("\n")) });
  }
  return cues;
}

export function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.startsWith("Dialogue:")) continue;
    const f = line.slice(9).split(",");
    if (f.length < 10) continue;
    const start = parseTime(f[1]);
    const end = parseTime(f[2]);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: stripTags(f.slice(9).join(",")) });
  }
  cues.sort((x, y) => x.start - y.start);
  return cues;
}

export function cueAt(cues: Cue[], t: number): string {
  // cues are roughly sorted; a linear scan is fine for a few thousand entries
  const hits: string[] = [];
  for (const c of cues) {
    if (c.start > t) break;
    if (t >= c.start && t < c.end) hits.push(c.text);
  }
  return hits.join("\n");
}
