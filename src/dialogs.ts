// Thin wrappers around the Tauri dialog/opener plugins with browser fallbacks,
// so the UI can be developed in a plain browser (`npm run dev`) without Tauri.
import * as dlg from "@tauri-apps/plugin-dialog";
import * as opener from "@tauri-apps/plugin-opener";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// In a plain browser (no Tauri) the pickers return a made-up path so the mock backend can respond.
const MOCK_MOVIE = "C:\\Movies\\Example Movie (2024).mkv";

export async function openFile(opts: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string; title?: string }): Promise<string | null> {
  if (!isTauri) return opts.filters?.[0]?.extensions.includes("mkv") ? MOCK_MOVIE : opts.defaultPath ?? MOCK_MOVIE;
  const r = await dlg.open({ multiple: false, directory: false, ...opts });
  return typeof r === "string" ? r : null;
}
export async function saveFile(opts: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> {
  if (!isTauri) return opts.defaultPath ?? null;
  return (await dlg.save(opts)) ?? null;
}
export async function askUser(text: string, title: string): Promise<boolean> {
  if (!isTauri) {
    console.log(`[ask] ${title}: ${text}`);
    return true;
  }
  return dlg.ask(text, { title });
}
export async function showMessage(text: string, title: string, kind: "info" | "warning" | "error" = "info"): Promise<void> {
  if (!isTauri) {
    console.log(`[${kind}] ${title}: ${text}`);
    return;
  }
  await dlg.message(text, { title, kind });
}
export function openUrl(url: string) {
  if (!isTauri) {
    window.open(url, "_blank");
    return;
  }
  opener.openUrl(url).catch(console.error);
}
export function openPath(path: string) {
  if (isTauri) opener.openPath(path).catch(console.error);
}
export function revealInDir(path: string) {
  if (isTauri) opener.revealItemInDir(path).catch(console.error);
}
