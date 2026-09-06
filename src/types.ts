export type EditKind = "remove" | "replace" | "textOverVideo" | "mute";
export type DurationMode = "fixed" | "match";

export interface Edit {
  id: string;
  kind: EditKind;
  start: number;
  end: number;
  text: string;
  durationMode: DurationMode;
  duration: number;
  enabled: boolean;
}

export interface VideoInfo {
  index: number;
  codec: string;
  profile?: string;
  level?: number;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  pixFmt?: string;
  colorTransfer?: string;
}
export interface AudioInfo {
  index: number;
  codec: string;
  channels: number;
  channelLayout?: string;
  sampleRate: number;
  language?: string;
  title?: string;
  default: boolean;
}
export interface SubInfo {
  index: number;
  codec: string;
  language?: string;
  title?: string;
  default: boolean;
  forced: boolean;
  text: boolean;
}
export interface Chapter {
  start: number;
  end: number;
  title: string;
}
export interface MediaInfo {
  path: string;
  fileName: string;
  container: string;
  duration: number;
  size: number;
  title?: string;
  video?: VideoInfo;
  audio: AudioInfo[];
  subtitles: SubInfo[];
  chapters: Chapter[];
}

export interface CardStyle {
  fontFile: string;
  fontSizeRatio: number;
  textColor: string;
  backgroundColor: string;
  fade: number;
  preset: string;
}
export interface ToolPaths {
  ffmpeg?: string | null;
  ffprobe?: string | null;
  mkvmerge?: string | null;
}
export interface Settings {
  tools: ToolPaths;
  card: CardStyle;
  previewWidth: number;
  csvExtension: string;
  outputSuffix: string;
  defaultCardSeconds: number;
}
export interface ToolStatus {
  ffmpeg?: string | null;
  ffprobe?: string | null;
  mkvmerge?: string | null;
  ffmpegVersion?: string | null;
  mkvmergeVersion?: string | null;
}
export interface AppliedEdit {
  id: string;
  kind: EditKind;
  requestedStart: number;
  requestedEnd: number;
  actualStart: number;
  actualEnd: number;
  cardSeconds?: number | null;
}
export interface RenderResult {
  output: string;
  duration: number;
  originalDuration: number;
  warnings: string[];
  applied: AppliedEdit[];
  secondsEncoded: number;
}

/** Plain-language names for the four edits. */
export const KIND_LABEL: Record<EditKind, string> = {
  remove: "Cut it out",
  replace: "Cut it out, show a card",
  textOverVideo: "Show a card, keep the sound",
  mute: "Mute the sound",
};
export const KIND_HELP: Record<EditKind, string> = {
  remove: "This part of the movie is removed. The movie gets shorter.",
  replace: "This part is removed and a card with your text is shown instead.",
  textOverVideo: "The picture is replaced by a card with your text, but the sound keeps playing. The movie stays the same length.",
  mute: "The sound is silenced for this part. The picture is untouched.",
};
export const KIND_ORDER: EditKind[] = ["remove", "replace", "textOverVideo", "mute"];

export function fps(m: MediaInfo | null): number {
  if (!m?.video) return 24;
  return m.video.fpsDen ? m.video.fpsNum / m.video.fpsDen : 24;
}

export function fmtTime(s: number, withMs = true): string {
  if (!isFinite(s)) return "--:--:--";
  s = Math.max(0, s);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  const milli = ms % 1000;
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return withMs ? `${base}.${String(milli).padStart(3, "0")}` : base;
}

/** Accepts H:MM:SS.mmm, MM:SS, SS, with , or . decimals. Returns null when unparsable. */
export function parseTime(str: string): number | null {
  const t = str.trim().replace(",", ".").replace(/s$/i, "");
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3) return null;
  let secs = 0;
  for (const p of parts) {
    if (p.trim() === "" || isNaN(Number(p))) return null;
    secs = secs * 60 + Number(p);
  }
  return secs;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(0) + " KB";
}

export function outputLength(edits: Edit[], duration: number): number {
  let d = duration;
  for (const e of edits) {
    if (!e.enabled) continue;
    const len = Math.max(0, Math.min(e.end, duration) - e.start);
    if (e.kind === "remove") d -= len;
    else if (e.kind === "replace") d -= len - (e.durationMode === "match" ? len : e.duration);
  }
  return d;
}
