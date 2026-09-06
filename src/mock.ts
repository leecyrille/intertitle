// Browser-only stand-in for the Rust backend. Lets `npm run dev` show the UI
// with a fake movie so layout and interaction can be worked on without Tauri.
import type { MediaInfo, Settings, ToolStatus } from "./types";

const settings: Settings = {
  tools: {},
  card: { fontFile: "", fontSizeRatio: 0.055, textColor: "white", backgroundColor: "black", fade: 0.75, preset: "fast" },
  thumbnailCount: 120,
  previewWidth: 1280,
  csvExtension: "csv",
  outputSuffix: " (edited)",
  defaultCardSeconds: 10,
};

const media: MediaInfo = {
  path: "C:\\Movies\\Example Movie (2024).mkv",
  fileName: "Example Movie (2024).mkv",
  container: "matroska,webm",
  duration: 5400,
  size: 12.3e9,
  video: { index: 0, codec: "hevc", width: 3840, height: 2160, fpsNum: 24, fpsDen: 1, pixFmt: "yuv420p10le" },
  audio: [{ index: 1, codec: "eac3", channels: 6, sampleRate: 48000, language: "eng", default: true }],
  subtitles: [
    { index: 2, codec: "subrip", language: "eng", default: false, forced: false, text: true },
    { index: 3, codec: "hdmv_pgs_subtitle", language: "fre", default: false, forced: false, text: false },
  ],
  chapters: Array.from({ length: 8 }, (_, i) => ({ start: i * 675, end: (i + 1) * 675, title: `Chapter ${i + 1}` })),
};

function fakeFrame(t: number, w: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = Math.round((w * 9) / 16);
  const g = c.getContext("2d")!;
  const hue = (t / media.duration) * 360;
  const grad = g.createLinearGradient(0, 0, c.width, c.height);
  grad.addColorStop(0, `hsl(${hue}, 45%, 25%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 12%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(255,255,255,0.8)";
  g.font = `${Math.round(c.height / 8)}px Georgia`;
  g.textAlign = "center";
  g.fillText(new Date(t * 1000).toISOString().substring(11, 19), c.width / 2, c.height / 2);
  return c.toDataURL("image/jpeg", 0.7).split(",")[1];
}

const listeners: Record<string, ((payload: unknown) => void)[]> = {};
function emit(name: string, payload: unknown) {
  (listeners[name] ?? []).forEach((cb) => cb(payload));
}

export const mockInvoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  await new Promise((r) => setTimeout(r, 30));
  switch (cmd) {
    case "get_settings":
      return settings;
    case "save_settings":
      Object.assign(settings, args.settings as Settings);
      return;
    case "tool_status":
      return { ffmpeg: "ffmpeg (mock)", ffprobe: "ffprobe (mock)", mkvmerge: "mkvmerge (mock)", ffmpegVersion: "ffmpeg 9.0 (mock)", mkvmergeVersion: "mkvmerge v73 (mock)" } as ToolStatus;
    case "probe_media":
      return { ...media, path: String(args.path), fileName: String(args.path).split(/[\\/]/).pop() };
    case "frame_at":
      return fakeFrame(Number(args.time), Number(args.width));
    case "start_thumbnails": {
      const count = Number(args.count);
      const dur = Number(args.duration);
      (async () => {
        for (let i = 0; i < count; i++) {
          await new Promise((r) => setTimeout(r, 8));
          const time = ((i + 0.5) * dur) / count;
          emit("thumbnail", { index: i, count, time, data: fakeFrame(time, 240) });
        }
      })();
      return;
    }
    case "subtitle_text":
      return {
        format: "srt",
        text: Array.from({ length: 300 }, (_, i) => `${i + 1}\n${fmt(i * 18)} --> ${fmt(i * 18 + 3)}\nSubtitle line ${i + 1}\n`).join("\n"),
      };
    case "preview_clip":
      throw new Error("Playback is not available in the browser mock.");
    case "path_exists":
      return false;
    case "read_text_file":
      return "";
    case "write_text_file":
      return;
    case "nearest_keyframe":
      return Math.round(Number(args.time) / 2.5) * 2.5;
    case "render": {
      (async () => {
        for (let p = 0; p <= 100; p += 5) {
          await new Promise((r) => setTimeout(r, 120));
          emit("render-progress", { stage: "mock", percent: p, message: p < 50 ? "Splitting (mock)" : "Joining (mock)" });
          emit("render-log", `mock progress ${p}%`);
        }
      })();
      await new Promise((r) => setTimeout(r, 2700));
      return { output: String((args.request as { output: string }).output), duration: 5300, originalDuration: 5400, warnings: [], applied: [], secondsEncoded: 10 };
    }
    default:
      throw new Error(`mock: unknown command ${cmd}`);
  }
};

export function mockListen(name: string, cb: (payload: unknown) => void): () => void {
  (listeners[name] ??= []).push(cb);
  return () => {
    listeners[name] = (listeners[name] ?? []).filter((x) => x !== cb);
  };
}

function fmt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},000`;
}
