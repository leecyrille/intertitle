import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { askUser, isTauri, openFile, openUrl, saveFile, showMessage } from "./dialogs";
import { api, dirOf, joinPath, stemOf } from "./api";
import { csvToEdits, editsToCsv } from "./csv";
import { cueAt, parseAss, parseSrt, type Cue } from "./subtitles";
import { fmtBytes, fmtTime, fps as fpsOf, KIND_ORDER, newId, outputLength, type Edit, type EditKind, type MediaInfo, type Settings, type ToolStatus } from "./types";
import Btn from "./components/Btn";
import EditList from "./components/EditList";
import HelpDialog from "./components/HelpDialog";
import Preview from "./components/Preview";
import RenderDialog from "./components/RenderDialog";
import SettingsDialog from "./components/SettingsDialog";
import { LINKS } from "./links";

const VIDEO_EXT = ["mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "mts", "mpg", "mpeg", "vob", "wmv", "flv", "ogv", "3gp"];
const SCRUB_WIDTH = 720; // px; keyframe grabs while dragging are scaled to this and cached
const SCRUB_CACHE_MAX = 600;

type Dialog = "none" | "render" | "settings" | "help";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [subTrack, setSubTrack] = useState<number | null>(null);
  const [audioIndex, setAudioIndex] = useState<number | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [showSubs, setShowSubs] = useState(true);
  const [dialog, setDialog] = useState<Dialog>("none");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fps = fpsOf(media);

  // scrub machinery: latest wanted time, at most two grabs in flight, results cached per half-second
  const wantRef = useRef<number | null>(null);
  const inFlight = useRef(0);
  const scrubbingRef = useRef(false);
  const exactReq = useRef(0);
  const cache = useRef<Map<string, string>>(new Map());
  const mediaRef = useRef<MediaInfo | null>(null);
  mediaRef.current = media;
  scrubbingRef.current = scrubbing;

  // ---------- startup ----------
  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => console.error(e));
    api.toolStatus().then(setTools).catch((e) => console.error(e));
  }, []);

  // Browser demo mode (screenshots): ?demo opens the mock movie; &t=SECONDS, &sel=N, &dialog=render|help|settings
  const demoDone = useRef(false);
  useEffect(() => {
    if (isTauri || !settings || demoDone.current) return;
    const q = new URLSearchParams(window.location.search);
    if (!q.has("demo")) return;
    demoDone.current = true;
    (async () => {
      await openMovie("C:/Movies/Big Buck Bunny (2008).mkv");
      const tt = Number(q.get("t"));
      if (tt > 0) setT(tt);
      const d = q.get("dialog") as Dialog | null;
      if (d) setTimeout(() => setDialog(d), 400);
      const sel = Number(q.get("sel"));
      if (sel > 0) setTimeout(() => setEdits((list) => (setSelectedId(list[sel - 1]?.id ?? null), list)), 300);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  // ---------- open a movie ----------
  const openMovie = useCallback(
    async (path?: string) => {
      if (!settings) return;
      if (!path) {
        const picked = await openFile({ filters: [{ name: "Video", extensions: VIDEO_EXT }, { name: "All files", extensions: ["*"] }] });
        if (!picked) return;
        path = picked;
      }
      setBusy("Reading the movie…");
      try {
        const info = await api.probe(path);
        setPlaying(false);
        setMedia(info);
        setEdits([]);
        setSelectedId(null);
        setT(0);
        setFrame(null);
        setCues([]);
        cache.current.clear();
        const firstText = info.subtitles.find((s) => s.text && s.default) ?? info.subtitles.find((s) => s.text && (s.language ?? "").startsWith("en")) ?? info.subtitles.find((s) => s.text);
        setSubTrack(firstText ? firstText.index : null);
        setShowSubs(true);
        setAudioIndex(info.audio.find((a) => a.default)?.index ?? info.audio[0]?.index ?? null);
        if (isTauri) getCurrentWindow().setTitle(`${info.fileName} — Intertitle`).catch(() => {});
        // auto-load an edit list saved next to the movie
        const csvPath = joinPath(dirOf(info.path), `${stemOf(info.path)}.${settings.csvExtension || "csv"}`);
        if (await api.pathExists(csvPath)) {
          try {
            const text = await api.readTextFile(csvPath);
            const { edits: loaded, errors } = csvToEdits(text, settings.defaultCardSeconds);
            if (loaded.length) {
              setEdits(loaded);
              showToast(`Loaded ${loaded.length} saved edit${loaded.length === 1 ? "" : "s"} for this movie${errors.length ? ` (${errors.length} lines skipped)` : ""}`);
            }
          } catch (e) {
            console.error(e);
          }
        }
      } catch (e) {
        await showMessage(String(e), "Could not open the file", "error");
      } finally {
        setBusy(null);
      }
    },
    [settings, showToast]
  );

  // ---------- frames ----------
  // While dragging: keyframe grabs, at most two in flight, always for the newest position.
  const pump = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    while (inFlight.current < 2 && wantRef.current !== null) {
      const at = wantRef.current;
      wantRef.current = null;
      const key = `${m.path}#${Math.round(at * 2)}`;
      const hit = cache.current.get(key);
      if (hit) {
        setFrame(hit);
        continue;
      }
      inFlight.current++;
      api
        .frameAt(m.path, at, SCRUB_WIDTH, false)
        .then((data) => {
          if (cache.current.size >= SCRUB_CACHE_MAX) cache.current.delete(cache.current.keys().next().value as string);
          cache.current.set(key, data);
          // only paint while still dragging, or if nothing newer is waiting
          if (scrubbingRef.current && wantRef.current === null) setFrame(data);
          else if (scrubbingRef.current) setFrame(data);
        })
        .catch((e) => console.error(e))
        .finally(() => {
          inFlight.current--;
          pump();
        });
    }
  }, []);

  useEffect(() => {
    if (!media || !settings || playing) return;
    if (scrubbing) {
      wantRef.current = t;
      pump();
      return;
    }
    // settled: the exact frame at full preview size
    const id = ++exactReq.current;
    setLoadingFrame(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.frameAt(media.path, t, settings.previewWidth, true);
        if (id === exactReq.current) setFrame(data);
      } catch (e) {
        console.error(e);
      } finally {
        if (id === exactReq.current) setLoadingFrame(false);
      }
    }, 30);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, media, playing, scrubbing]);

  // ---------- subtitles ----------
  useEffect(() => {
    if (!media || subTrack === null) {
      setCues([]);
      return;
    }
    let cancelled = false;
    api
      .subtitleText(media.path, subTrack)
      .then((r) => {
        if (cancelled) return;
        setCues(r.format === "ass" ? parseAss(r.text) : parseSrt(r.text));
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [media, subTrack]);
  const subText = useMemo(() => (showSubs && cues.length ? cueAt(cues, t) : ""), [cues, t, showSubs]);

  // ---------- edits ----------
  const selected = edits.find((e) => e.id === selectedId) ?? null;
  const sortEdits = (list: Edit[]) => [...list].sort((a, b) => a.start - b.start);
  const updateEdit = useCallback((id: string, patch: Partial<Edit>) => {
    setEdits((list) => sortEdits(list.map((e) => (e.id === id ? { ...e, ...patch } : e))));
  }, []);
  const deleteEdit = useCallback(
    (id: string) => {
      setEdits((list) => list.filter((e) => e.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [selectedId]
  );
  const addEdit = useCallback(
    (start: number, end: number, kind: EditKind = "remove") => {
      if (!media || !settings) return;
      const e: Edit = {
        id: newId(),
        kind,
        start: Math.max(0, Math.min(start, media.duration)),
        end: Math.max(0, Math.min(end, media.duration)),
        text: "",
        durationMode: "fixed",
        duration: settings.defaultCardSeconds,
        enabled: true,
      };
      if (e.end <= e.start) e.end = Math.min(e.start + 1, media.duration);
      setEdits((list) => sortEdits([...list, e]));
      setSelectedId(e.id);
      return e;
    },
    [media, settings]
  );
  const setStartHere = useCallback(() => {
    if (!media || !settings) return;
    if (selected) {
      updateEdit(selected.id, { start: t, end: t >= selected.end ? Math.min(t + settings.defaultCardSeconds, media.duration) : selected.end });
      showToast(`Start moved to ${fmtTime(t)}`);
    } else {
      addEdit(t, Math.min(t + settings.defaultCardSeconds, media.duration));
      showToast("New edit started here. Move to where it should end and press O (or click End here).");
    }
  }, [media, settings, selected, t, updateEdit, addEdit, showToast]);
  const setEndHere = useCallback(() => {
    if (!media || !settings) return;
    if (selected) {
      updateEdit(selected.id, { end: t, start: t <= selected.start ? Math.max(t - settings.defaultCardSeconds, 0) : selected.start });
      showToast(`End moved to ${fmtTime(t)}`);
    } else {
      addEdit(Math.max(0, t - settings.defaultCardSeconds), t);
      showToast("New edit ending here. Press I (or click Start here) where it should begin.");
    }
  }, [media, settings, selected, t, updateEdit, addEdit, showToast]);
  const newEditHere = useCallback(() => {
    if (!media || !settings) return;
    addEdit(t, Math.min(t + settings.defaultCardSeconds, media.duration));
    showToast("New edit added at the playhead. Adjust its start and end, then pick what to do with it.");
  }, [media, settings, t, addEdit, showToast]);

  // ---------- edit lists ----------
  const saveList = useCallback(async () => {
    if (!media || !settings) return;
    const ext = settings.csvExtension || "csv";
    const path = await saveFile({ defaultPath: joinPath(dirOf(media.path), `${stemOf(media.path)}.${ext}`), filters: [{ name: "Edit list", extensions: [ext] }] });
    if (!path) return;
    await api.writeTextFile(path, editsToCsv(edits));
    showToast(`Saved ${edits.length} edit${edits.length === 1 ? "" : "s"}. They load again automatically when you open this movie.`);
  }, [media, settings, edits, showToast]);
  const loadList = useCallback(async () => {
    if (!media || !settings) return;
    const ext = settings.csvExtension || "csv";
    const path = await openFile({ defaultPath: dirOf(media.path), filters: [{ name: "Edit list", extensions: [ext, "csv", "txt"] }, { name: "All files", extensions: ["*"] }] });
    if (!path) return;
    const { edits: loaded, errors } = csvToEdits(await api.readTextFile(path), settings.defaultCardSeconds);
    if (errors.length && loaded.length === 0) {
      await showMessage(errors.join("\n"), "Nothing could be loaded", "error");
      return;
    }
    let replace = true;
    if (edits.length) replace = await askUser(`Replace the current ${edits.length} edits with the ${loaded.length} loaded ones? Choose No to add them instead.`, "Load edit list");
    setEdits(replace ? loaded : sortEdits([...edits, ...loaded]));
    setSelectedId(null);
    showToast(`Loaded ${loaded.length} edits${errors.length ? `, ${errors.length} lines skipped` : ""}`);
  }, [media, settings, edits, showToast]);

  // ---------- keyboard ----------
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (dialog !== "none") {
        if (ev.key === "Escape" && dialog !== "render") setDialog("none");
        return;
      }
      if (ev.ctrlKey || ev.metaKey) {
        const k = ev.key.toLowerCase();
        if (k === "o") {
          ev.preventDefault();
          openMovie();
        } else if (k === "s" && media) {
          ev.preventDefault();
          saveList();
        } else if (k === "l" && media) {
          ev.preventDefault();
          loadList();
        } else if (k === "enter" && media) {
          ev.preventDefault();
          setDialog("render");
        } else if (media && (ev.key === "ArrowLeft" || ev.key === "ArrowRight") && !typing) {
          ev.preventDefault();
          seek(t + (ev.key === "ArrowLeft" ? -10 : 10));
        }
        return;
      }
      if (typing) return;
      if (!media) return;
      const step = ev.shiftKey ? 1 : 1 / fps;
      switch (ev.key) {
        case " ":
          ev.preventDefault();
          setPlaying((p) => !p);
          break;
        case "ArrowLeft":
          ev.preventDefault();
          seek(t - step);
          break;
        case "ArrowRight":
          ev.preventDefault();
          seek(t + step);
          break;
        case "Home":
          ev.preventDefault();
          seek(0);
          break;
        case "End":
          ev.preventDefault();
          seek(media.duration);
          break;
        case "i":
        case "I":
          setStartHere();
          break;
        case "o":
        case "O":
          setEndHere();
          break;
        case "n":
        case "N":
          newEditHere();
          break;
        case "c":
        case "C":
          setShowSubs((s) => !s);
          break;
        case "[":
          if (selected) seek(selected.start);
          break;
        case "]":
          if (selected) seek(selected.end);
          break;
        case "Delete":
        case "Backspace":
          if (selected) deleteEdit(selected.id);
          break;
        case "Escape":
          setSelectedId(null);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          ev.preventDefault();
          if (!edits.length) break;
          const i = edits.findIndex((e) => e.id === selectedId);
          const ni = i < 0 ? 0 : Math.min(edits.length - 1, Math.max(0, i + (ev.key === "ArrowDown" ? 1 : -1)));
          setSelectedId(edits[ni].id);
          break;
        }
        case "1":
        case "2":
        case "3":
        case "4":
          if (selected) updateEdit(selected.id, { kind: KIND_ORDER[Number(ev.key) - 1] });
          break;
        case "?":
          setDialog("help");
          break;
      }
    };
    const seek = (v: number) => {
      setPlaying(false);
      setScrubbing(false);
      setT(Math.min(Math.max(v, 0), media?.duration ?? 0));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dialog, media, t, fps, selected, selectedId, edits, openMovie, saveList, loadList, setStartHere, setEndHere, newEditHere, deleteEdit, updateEdit]);

  const onSeek = useCallback((v: number, isScrub: boolean) => {
    setScrubbing(isScrub);
    setT(v);
  }, []);

  const subTracks = useMemo(
    () =>
      (media?.subtitles ?? [])
        .filter((s) => s.text)
        .map((s) => ({ index: s.index, label: `${s.language ?? "und"}${s.title ? ` · ${s.title}` : ""} (${s.codec})` })),
    [media]
  );
  const enabledCount = edits.filter((e) => e.enabled).length;

  if (!settings) return <div className="loading">Starting…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" title="Intertitle">
          <span className="logo">Inter</span>
          <span className="logo2">TITLE</span>
        </div>
        <Btn onClick={() => openMovie()} primary={!media} tip="Pick a movie file to edit" shortcut="Ctrl+O">
          Open a movie…
        </Btn>
        {media && (
          <div className="file-info" title={media.path}>
            <b>{media.fileName}</b>
            <span className="dim">
              {media.video ? ` ${media.video.width}×${media.video.height} ${media.video.codec}` : ""} · {fmtTime(media.duration, false)} · {fmtBytes(media.size)} · {media.audio.length} audio ·{" "}
              {media.subtitles.length} subtitle{media.subtitles.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        <div className="spacer" />
        <Btn onClick={loadList} disabled={!media} tip="Load a list of edits you saved earlier" shortcut="Ctrl+L">
          Load edit list…
        </Btn>
        <Btn onClick={saveList} disabled={!media || edits.length === 0} tip="Save this list of edits next to the movie" shortcut="Ctrl+S">
          Save edit list…
        </Btn>
        <Btn onClick={() => setDialog("render")} disabled={!media || enabledCount === 0} primary tip="Write a new movie file with these edits applied" shortcut="Ctrl+Enter">
          Make the edited movie…
        </Btn>
        <Btn onClick={() => setDialog("settings")} tip="Where ffmpeg and MKVToolNix are, how cards look">
          Settings
        </Btn>
        <Btn onClick={() => setDialog("help")} tip="How it works and keyboard shortcuts" shortcut="?">
          Help
        </Btn>
        <Btn onClick={() => openUrl(LINKS.tipJar)} tip="Intertitle is free. Tips keep it going.">
          ☕ Tip jar
        </Btn>
      </header>

      {!tools?.mkvmerge || !tools?.ffmpeg ? (
        <div className="banner">
          {!tools?.ffmpeg && <span>ffmpeg was not found. </span>}
          {!tools?.mkvmerge && <span>MKVToolNix was not found. </span>}
          Intertitle needs both to make the edited movie.{" "}
          <button className="link" onClick={() => setDialog("settings")}>
            Tell Intertitle where they are
          </button>{" "}
          or install them:{" "}
          <button className="link" onClick={() => openUrl("https://www.gyan.dev/ffmpeg/builds/")}>
            ffmpeg
          </button>
          ,{" "}
          <button className="link" onClick={() => openUrl("https://mkvtoolnix.download/downloads.html")}>
            MKVToolNix
          </button>
          .
        </div>
      ) : null}

      {media ? (
        <>
          <Preview
            media={media}
            fps={fps}
            t={t}
            onSeek={onSeek}
            frame={frame}
            edits={edits}
            selectedId={selectedId}
            onSelect={setSelectedId}
            playing={playing}
            setPlaying={setPlaying}
            subText={subText}
            showSubs={showSubs}
            setShowSubs={setShowSubs}
            audioIndex={audioIndex}
            setAudioIndex={setAudioIndex}
            onSetStart={setStartHere}
            onSetEnd={setEndHere}
            onNewEdit={newEditHere}
            subTracks={subTracks}
            subTrack={subTrack}
            setSubTrack={setSubTrack}
            loadingFrame={loadingFrame}
          />
          <section className="edits">
            <div className="edits-head">
              <h2>Your edits</h2>
              <span className="dim">
                {selected ? "Start here / End here move the highlighted edit." : "Nothing highlighted: Start here begins a new edit."} Click a row to highlight it.
              </span>
              <div className="spacer" />
              <span className="dim">
                Edited movie will be about <b>{fmtTime(outputLength(edits, media.duration), false)}</b>
              </span>
            </div>
            <EditList
              edits={edits}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={updateEdit}
              onDelete={deleteEdit}
              onSeek={(v) => onSeek(v, false)}
              onAdd={newEditHere}
              duration={media.duration}
              defaultCardSeconds={settings.defaultCardSeconds}
            />
          </section>
        </>
      ) : (
        <div className="welcome" onDoubleClick={() => openMovie()}>
          <div className="welcome-card">
            <h1>Skip scenes. Mute lines. Drop in a title card.</h1>
            <p>Open a movie to begin. Nothing is re-encoded, so there is no quality loss and even a 4K film is done in minutes.</p>
            <Btn onClick={() => openMovie()} primary tip="Pick a movie file to edit" shortcut="Ctrl+O">
              Open a movie…
            </Btn>
            <p className="dim small">
              MKV, MP4, MOV, AVI, TS, WebM and more. Needs ffmpeg and MKVToolNix — press <kbd>?</kbd> for help.
            </p>
          </div>
        </div>
      )}

      {busy && <div className="busy">{busy}</div>}
      {toast && <div className="toast">{toast}</div>}
      {dialog === "render" && media && <RenderDialog media={media} edits={edits} settings={settings} tools={tools} onClose={() => setDialog("none")} />}
      {dialog === "settings" && (
        <SettingsDialog
          settings={settings}
          tools={tools}
          onClose={() => setDialog("none")}
          onSave={async (s) => {
            await api.saveSettings(s);
            setSettings(s);
            setDialog("none");
            api.toolStatus().then(setTools).catch(() => {});
          }}
        />
      )}
      {dialog === "help" && <HelpDialog onClose={() => setDialog("none")} />}
    </div>
  );
}
