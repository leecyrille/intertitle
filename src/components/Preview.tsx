import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fmtTime, parseTime, type Edit, type MediaInfo } from "../types";
import Btn from "./Btn";

interface Props {
  media: MediaInfo;
  fps: number;
  t: number;
  onSeek: (t: number, scrubbing: boolean) => void;
  frame: string | null;
  edits: Edit[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  subText: string;
  showSubs: boolean;
  setShowSubs: (v: boolean) => void;
  audioIndex: number | null;
  setAudioIndex: (i: number | null) => void;
  onSetStart: () => void;
  onSetEnd: () => void;
  onNewEdit: () => void;
  subTracks: { index: number; label: string }[];
  subTrack: number | null;
  setSubTrack: (i: number | null) => void;
  loadingFrame: boolean;
}

const CHUNK = 8; // seconds of proxy video per request

export default function Preview(p: Props) {
  const { media, fps, t, onSeek, playing, setPlaying } = p;
  const dur = media.duration;
  const barRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [timeText, setTimeText] = useState(fmtTime(t));
  const [editingTime, setEditingTime] = useState(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipStart, setClipStart] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const nextClip = useRef<{ start: number; url: string } | null>(null);
  const playGen = useRef(0);
  const dragging = useRef(false);

  useEffect(() => {
    if (!editingTime) setTimeText(fmtTime(t));
  }, [t, editingTime]);

  // ---------- playback via short proxy clips ----------
  const fetchClip = useCallback(
    async (start: number) => {
      const d = Math.min(CHUNK, dur - start);
      if (d <= 0.05) return null;
      const b64 = await api.previewClip(media.path, start, d, 360, p.audioIndex);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    },
    [media.path, dur, p.audioIndex]
  );

  useEffect(() => {
    if (!playing) {
      playGen.current++;
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      setClipUrl(null);
      if (nextClip.current) URL.revokeObjectURL(nextClip.current.url);
      nextClip.current = null;
      setBuffering(false);
      return;
    }
    const gen = ++playGen.current;
    const start = t;
    setBuffering(true);
    (async () => {
      try {
        const url = await fetchClip(start);
        if (gen !== playGen.current) return;
        if (!url) {
          setPlaying(false);
          return;
        }
        setClipStart(start);
        setClipUrl(url);
        setBuffering(false);
        const nStart = start + CHUNK;
        if (nStart < dur) {
          fetchClip(nStart).then((u) => {
            if (gen === playGen.current && u) nextClip.current = { start: nStart, url: u };
            else if (u) URL.revokeObjectURL(u);
          });
        }
      } catch (e) {
        console.error(e);
        setPlaying(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const onEnded = async () => {
    const gen = playGen.current;
    const finishedAt = clipStart + CHUNK;
    if (finishedAt >= dur - 0.05) {
      setPlaying(false);
      onSeek(dur, false);
      return;
    }
    let nxt = nextClip.current;
    nextClip.current = null;
    if (!nxt) {
      setBuffering(true);
      const url = await fetchClip(finishedAt);
      if (gen !== playGen.current) return;
      if (!url) {
        setPlaying(false);
        return;
      }
      nxt = { start: finishedAt, url };
    }
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    setClipStart(nxt.start);
    setClipUrl(nxt.url);
    setBuffering(false);
    const after = nxt.start + CHUNK;
    if (after < dur) {
      fetchClip(after).then((u) => {
        if (gen === playGen.current && u) nextClip.current = { start: after, url: u };
        else if (u) URL.revokeObjectURL(u);
      });
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (v && clipUrl) {
      v.src = clipUrl;
      v.play().catch(() => {});
    }
  }, [clipUrl]);

  // ---------- scrub bar ----------
  const timeFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    return (x / r.width) * dur;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (playing) setPlaying(false);
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(timeFromEvent(e), true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    setHover(timeFromEvent(e));
    if (dragging.current) onSeek(timeFromEvent(e), true);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging.current) {
      dragging.current = false;
      onSeek(timeFromEvent(e), false);
    }
  };
  // fine scrubbing: mouse wheel over the bar or the picture steps by frames (Shift = seconds)
  const onWheel = (e: React.WheelEvent) => {
    if (playing) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const step = e.shiftKey ? 1 : e.ctrlKey ? 10 : 1 / fps;
    onSeek(Math.min(Math.max(t + dir * step, 0), dur), false);
  };

  const step = (secs: number) => {
    if (playing) setPlaying(false);
    onSeek(Math.min(Math.max(t + secs, 0), dur), false);
  };

  const commitTime = () => {
    const v = parseTime(timeText);
    setEditingTime(false);
    if (v !== null) onSeek(Math.min(Math.max(v, 0), dur), false);
    else setTimeText(fmtTime(t));
  };

  const aspect = media.video ? `${media.video.width} / ${media.video.height}` : "16 / 9";
  const selected = p.edits.find((e) => e.id === p.selectedId);

  return (
    <div className="preview">
      <div className="screen" style={{ aspectRatio: aspect }} onWheel={onWheel}>
        {p.frame && <img className="frame" src={`data:image/jpeg;base64,${p.frame}`} alt="" style={{ visibility: playing && clipUrl ? "hidden" : "visible" }} />}
        {!p.frame && !playing && <div className="frame-placeholder">Loading frame…</div>}
        <video
          ref={videoRef}
          className="frame"
          style={{ display: playing && clipUrl ? "block" : "none" }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (playing) onSeek(Math.min(clipStart + v.currentTime, dur), true);
          }}
          onEnded={onEnded}
          playsInline
        />
        {p.showSubs && p.subText && !buffering && (
          <div className="subtitle-overlay">
            {p.subText.split("\n").map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>
        )}
        {buffering && <div className="buffering">Loading preview…</div>}
        {p.loadingFrame && !playing && !buffering && <div className="frame-spinner" />}
        <div className="screen-time">{fmtTime(t)}</div>
      </div>

      <div
        className="scrub"
        ref={barRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        title="Drag to scrub. Mouse wheel steps one frame (Shift: 1 s, Ctrl: 10 s)."
      >
        <div className="ticks">
          {Array.from({ length: 11 }, (_, i) => (
            <span key={i} style={{ left: `${i * 10}%` }}>
              {fmtTime((i / 10) * dur, false).replace(/^00:/, "")}
            </span>
          ))}
        </div>
        {media.chapters.map((c, i) => (
          <div key={"c" + i} className="chapter-mark" style={{ left: `${(c.start / dur) * 100}%` }} title={c.title} />
        ))}
        {p.edits.map((e) => (
          <div
            key={e.id}
            className={`range ${e.kind} ${e.id === p.selectedId ? "selected" : ""} ${e.enabled ? "" : "off"}`}
            style={{ left: `${(e.start / dur) * 100}%`, width: `${(Math.max(e.end - e.start, 0) / dur) * 100}%` }}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              p.onSelect(e.id);
              onSeek(e.start, false);
            }}
            title={`${e.kind} ${fmtTime(e.start, false)} – ${fmtTime(e.end, false)}`}
          />
        ))}
        <div className="playhead" style={{ left: `${(t / dur) * 100}%` }} />
        {hover !== null && !dragging.current && (
          <div className="hover-pop" style={{ left: `${(hover / dur) * 100}%` }}>
            {fmtTime(hover, false)}
          </div>
        )}
      </div>

      <div className="controls">
        <div className="group">
          <Btn onClick={() => step(-dur)} tip="Go to start" shortcut="Home">
            ⏮
          </Btn>
          <Btn onClick={() => step(-10)} tip="Back 10 s" shortcut="Ctrl+←">
            −10s
          </Btn>
          <Btn onClick={() => step(-1)} tip="Back 1 s" shortcut="Shift+←">
            −1s
          </Btn>
          <Btn onClick={() => step(-1 / fps)} tip="Back one frame" shortcut="←">
            ◀
          </Btn>
          <Btn onClick={() => setPlaying(!playing)} primary tip={playing ? "Pause" : "Play (low-res preview with sound)"} shortcut="Space">
            {playing ? "❚❚" : "▶"}
          </Btn>
          <Btn onClick={() => step(1 / fps)} tip="Forward one frame" shortcut="→">
            ▶
          </Btn>
          <Btn onClick={() => step(1)} tip="Forward 1 s" shortcut="Shift+→">
            +1s
          </Btn>
          <Btn onClick={() => step(10)} tip="Forward 10 s" shortcut="Ctrl+→">
            +10s
          </Btn>
          <Btn onClick={() => step(dur)} tip="Go to end" shortcut="End">
            ⏭
          </Btn>
        </div>
        <div className="group">
          <input
            className="time-input"
            value={timeText}
            onFocus={() => setEditingTime(true)}
            onChange={(e) => setTimeText(e.target.value)}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTimeText(fmtTime(t));
                (e.target as HTMLInputElement).blur();
              }
            }}
            title="Type a time and press Enter"
          />
          <span className="dim">/ {fmtTime(dur, false)}</span>
        </div>
        <div className="group">
          <Btn onClick={p.onSetStart} tip={selected ? "Set the selected edit's start to here" : "Start a new edit here"} shortcut="I" active={!!selected}>
            ⇤ Start here
          </Btn>
          <Btn onClick={p.onSetEnd} tip={selected ? "Set the selected edit's end to here" : "End a new edit here"} shortcut="O" active={!!selected}>
            End here ⇥
          </Btn>
          <Btn onClick={p.onNewEdit} tip="Add a new edit starting here" shortcut="N">
            + Add an edit here
          </Btn>
        </div>
        <div className="group">
          <select
            className="track-select"
            value={p.audioIndex ?? ""}
            onChange={(e) => p.setAudioIndex(e.target.value === "" ? null : Number(e.target.value))}
            title="Audio track for the preview"
          >
            {media.audio.length === 0 && <option value="">No audio</option>}
            {media.audio.map((a, i) => (
              <option key={a.index} value={a.index}>
                🔊 {a.language ?? "und"}
                {a.title ? ` · ${a.title}` : ""} ({a.codec} {a.channels}ch){media.audio.length > 1 ? ` #${i + 1}` : ""}
              </option>
            ))}
          </select>
          <Btn onClick={() => p.setShowSubs(!p.showSubs)} active={p.showSubs} tip="Show subtitles on the preview" shortcut="C">
            CC
          </Btn>
          <select
            className="track-select"
            value={p.subTrack ?? ""}
            onChange={(e) => p.setSubTrack(e.target.value === "" ? null : Number(e.target.value))}
            title="Subtitle track to preview"
          >
            <option value="">{p.subTracks.length ? "No subtitles" : "No text subtitles in file"}</option>
            {p.subTracks.map((s) => (
              <option key={s.index} value={s.index}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
