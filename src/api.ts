import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./dialogs";
import { mockInvoke, mockListen } from "./mock";
import type { CardStyle, Edit, MediaInfo, RenderResult, Settings, ToolStatus } from "./types";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => (isTauri ? tauriInvoke<T>(cmd, args) : (mockInvoke(cmd, args) as Promise<T>));
const listen = <T,>(name: string, cb: (ev: { payload: T }) => void): Promise<UnlistenFn> =>
  isTauri ? tauriListen<T>(name, cb) : Promise.resolve(mockListen(name, (payload) => cb({ payload: payload as T })));

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  toolStatus: () => invoke<ToolStatus>("tool_status"),
  probe: (path: string) => invoke<MediaInfo>("probe_media", { path }),
  keyframesNear: (path: string, time: number, window: number) => invoke<number[]>("keyframes_near", { path, time, window }),
  nearestKeyframe: (path: string, time: number, duration: number) => invoke<number>("nearest_keyframe", { path, time, duration }),
  /** accurate=false lands on the keyframe before `time` and is several times faster */
  frameAt: (path: string, time: number, width: number, accurate: boolean) => invoke<string>("frame_at", { path, time, width, accurate }),
  previewClip: (path: string, start: number, duration: number, height: number, audioIndex: number | null) =>
    invoke<string>("preview_clip", { path, start, duration, height, audioIndex }),
  subtitleText: (path: string, streamIndex: number) => invoke<{ format: string; text: string }>("subtitle_text", { path, streamIndex }),
  render: (request: { path: string; edits: Edit[]; output: string; container: string; style: CardStyle; keepTemp: boolean }) =>
    invoke<RenderResult>("render", { request }),
  cancelRender: () => invoke<void>("cancel_render"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  defaultFont: () => invoke<string | null>("default_font"),
};

export interface ProgressEvent {
  stage: string;
  percent: number;
  message: string;
}

export function onProgress(cb: (e: ProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ProgressEvent>("render-progress", (ev) => cb(ev.payload));
}
export function onLog(cb: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>("render-log", (ev) => cb(ev.payload));
}

export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : "";
}
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}
export function stemOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}
export function extOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
