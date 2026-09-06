// Browser-only stand-in for the Rust backend. Lets `npm run dev` show the UI
// with a fake movie so layout and interaction can be worked on without Tauri.
//
// When `public/demo/frames/NNN.jpg` exist (see scripts/demo-frames.sh) the mock
// shows those real frames; otherwise it draws coloured placeholders.
import type { MediaInfo, Settings, ToolStatus } from "./types";

const settings: Settings = {
  tools: {},
  card: { fontFile: "", fontSizeRatio: 0.055, textColor: "white", backgroundColor: "black", fade: 0.75, preset: "fast" },
  previewWidth: 1280,
  csvExtension: "csv",
  outputSuffix: " (edited)",
  defaultCardSeconds: 10,
};

// Metadata matches Big Buck Bunny (2008), 720p, the file used for the demo frames.
const DEMO_FRAMES = 120;
const media: MediaInfo = {
  path: "C:\\Movies\\Big Buck Bunny (2008).mkv",
  fileName: "Big Buck Bunny (2008).mkv",
  container: "matroska,webm",
  duration: 596.47,
  size: 332e6,
  video: { index: 0, codec: "h264", width: 1280, height: 720, fpsNum: 24, fpsDen: 1, pixFmt: "yuv420p" },
  audio: [{ index: 1, codec: "ac3", channels: 6, sampleRate: 48000, language: "eng", default: true }],
  subtitles: [{ index: 2, codec: "subrip", language: "eng", default: false, forced: false, text: true }],
  chapters: [
    { start: 0, end: 62, title: "Morning" },
    { start: 62, end: 180, title: "Bunny" },
    { start: 180, end: 300, title: "The rodents" },
    { start: 300, end: 480, title: "Payback" },
    { start: 480, end: 596.47, title: "Credits" },
  ],
};

// Edits that load automatically, as if a CSV sat next to the movie.
const DEMO_CSV = `start,end,action,text,card_seconds,enabled
00:03:06.000,00:03:52.000,replace,"The three rodents torment a butterfly. Bunny has seen enough.",8,yes
00:04:20.000,00:04:30.000,mute,-,-,yes
00:06:55.000,00:07:05.000,text-keep-audio,"Bunny springs his trap.",match,yes
`;

let demoAvailable: boolean | null = null;
async function demoFrame(t: number): Promise<string | null> {
  if (demoAvailable === false) return null;
  const i = Math.min(DEMO_FRAMES - 1, Math.max(0, Math.floor((t / media.duration) * DEMO_FRAMES)));
  try {
    const r = await fetch(`/demo/frames/${String(i).padStart(3, "0")}.jpg`);
    if (!r.ok) throw new Error("missing");
    demoAvailable = true;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode(...buf.subarray(k, k + 0x8000));
    return btoa(bin);
  } catch {
    if (demoAvailable === null) demoAvailable = false;
    return null;
  }
}

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
  await new Promise((r) => setTimeout(r, 20));
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
      return (await demoFrame(Number(args.time))) ?? fakeFrame(Number(args.time), Number(args.width));
    case "subtitle_text":
      return {
        format: "srt",
        text: (
          [
            [70, 74, "(Bunny yawns and stretches)"],
            [96, 100, "(birds singing)"],
            [190, 194, "(the rodents snicker)"],
            [250, 254, "(butterfly flutters by)"],
            [330, 334, "(Bunny growls)"],
          ] as [number, number, string][]
        )
          .map(([a, b, t], i) => `${i + 1}\n${fmt(a)} --> ${fmt(b)}\n${t}\n`)
          .join("\n"),
      };
    case "preview_clip":
      throw new Error("Playback is not available in the browser mock.");
    case "path_exists":
      return String(args.path).endsWith(".csv");
    case "read_text_file":
      return DEMO_CSV;
    case "write_text_file":
      return;
    case "nearest_keyframe":
      return Math.round(Number(args.time) / 2.5) * 2.5;
    case "render": {
      (async () => {
        for (let p = 0; p <= 100; p += 5) {
          await new Promise((r) => setTimeout(r, 120));
          emit("render-progress", { stage: "mock", percent: p, message: p < 50 ? "Splitting the movie at the cut points (stream copy)" : "Joining the pieces (stream copy)" });
          emit("render-log", `mock progress ${p}%`);
        }
      })();
      await new Promise((r) => setTimeout(r, 2700));
      return {
        output: String((args.request as { output: string }).output),
        duration: 565.4,
        originalDuration: 596.47,
        warnings: [],
        applied: [
          { id: "a", kind: "replace", requestedStart: 186, requestedEnd: 232, actualStart: 186.25, actualEnd: 232.208, cardSeconds: 8 },
          { id: "b", kind: "mute", requestedStart: 260, requestedEnd: 270, actualStart: 260, actualEnd: 270, cardSeconds: null },
          { id: "c", kind: "textOverVideo", requestedStart: 415, requestedEnd: 425, actualStart: 415.125, actualEnd: 425.083, cardSeconds: 9.958 },
        ],
        secondsEncoded: 16,
      };
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
