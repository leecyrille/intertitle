import { useEffect, useRef, useState } from "react";
import { openPath, revealInDir, saveFile } from "../dialogs";
import { api, dirOf, extOf, joinPath, onLog, onProgress, stemOf } from "../api";
import { fmtTime, KIND_LABEL, outputLength, type Edit, type MediaInfo, type RenderResult, type Settings, type ToolStatus } from "../types";
import Btn from "./Btn";

interface Props {
  media: MediaInfo;
  edits: Edit[];
  settings: Settings;
  tools: ToolStatus | null;
  onClose: () => void;
}

export default function RenderDialog({ media, edits, settings, tools, onClose }: Props) {
  const srcExt = extOf(media.path);
  const [container, setContainer] = useState<"mkv" | "mp4">(srcExt === "mp4" || srcExt === "m4v" || srcExt === "mov" ? "mp4" : "mkv");
  const [output, setOutput] = useState(joinPath(dirOf(media.path), `${stemOf(media.path)}${settings.outputSuffix}.${container}`));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ stage: "", percent: 0, message: "" });
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [keepTemp, setKeepTemp] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setOutput((o) => o.replace(/\.(mkv|mp4)$/i, "") + "." + container);
  }, [container]);

  useEffect(() => {
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    onProgress((e) => setProgress((p) => ({ stage: e.stage, percent: e.percent, message: e.message || p.message }))).then((u) => (un1 = u));
    onLog((line) => setLog((l) => (l.length > 400 ? [...l.slice(-300), line] : [...l, line]))).then((u) => (un2 = u));
    return () => {
      un1?.();
      un2?.();
    };
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const enabled = edits.filter((e) => e.enabled);
  const removed = enabled.filter((e) => e.kind === "remove" || e.kind === "replace").reduce((a, e) => a + (e.end - e.start), 0);
  const cards = enabled.filter((e) => e.kind === "replace" || e.kind === "textOverVideo");
  const encodeSeconds = cards.reduce((a, e) => a + (e.kind === "textOverVideo" || e.durationMode === "match" ? e.end - e.start : e.duration), 0);
  const imageSubs = media.subtitles.filter((s) => !s.text);
  const timelineChanges = enabled.some((e) => e.kind === "remove" || e.kind === "replace");
  const missingText = cards.filter((e) => !e.text.trim());
  const canRun = !!tools?.mkvmerge && !!tools?.ffmpeg && enabled.length > 0 && missingText.length === 0 && !running;

  const pick = async () => {
    const path = await saveFile({ defaultPath: output, filters: [{ name: container.toUpperCase(), extensions: [container] }] });
    if (path) setOutput(path);
  };

  const start = async () => {
    setError(null);
    setResult(null);
    setLog([]);
    setRunning(true);
    try {
      const res = await api.render({ path: media.path, edits: enabled, output, container, style: settings.card, keepTemp });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal render">
        <h2>Render</h2>
        {!result && (
          <>
            <div className="summary">
              <div>
                <b>{enabled.length}</b> edit{enabled.length === 1 ? "" : "s"}
                {enabled.length > 0 && (
                  <span className="dim">
                    {" "}
                    ({Object.entries(
                      enabled.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {})
                    )
                      .map(([k, n]) => `${n} ${KIND_LABEL[k as Edit["kind"]].toLowerCase()}`)
                      .join(", ")}
                    )
                  </span>
                )}
              </div>
              <div>
                Original {fmtTime(media.duration, false)} → about <b>{fmtTime(outputLength(edits, media.duration), false)}</b>
                {removed > 0 && <span className="dim"> ({fmtTime(removed, false)} removed)</span>}
              </div>
              <div>
                Encoding needed: <b>{encodeSeconds > 0 ? `${encodeSeconds.toFixed(1)} s of title cards` : "none"}</b>. Everything else is copied as-is.
              </div>
            </div>
            <div className="warn-list">
              {!tools?.mkvmerge && <div className="warn err">mkvmerge (MKVToolNix) is required for cutting and joining. Install it or set its path in Settings.</div>}
              {!tools?.ffmpeg && <div className="warn err">ffmpeg is required. Install it or set its path in Settings.</div>}
              {missingText.length > 0 && <div className="warn err">{missingText.length} card edit{missingText.length > 1 ? "s have" : " has"} no text yet.</div>}
              {timelineChanges && imageSubs.length > 0 && (
                <div className="warn">
                  {imageSubs.length} image based subtitle track{imageSubs.length > 1 ? "s" : ""} ({imageSubs.map((s) => s.codec).join(", ")}) will be dropped because the
                  running time changes. Text subtitles are retimed and kept.
                </div>
              )}
              {timelineChanges && <div className="warn info">Cuts land on the nearest keyframe, usually within a second of the times you chose. The exact points are reported when done.</div>}
              {container === "mp4" && <div className="warn info">MP4 output keeps text subtitles (as mov_text) and chapters. Choose MKV to keep every subtitle format.</div>}
            </div>
            <div className="field-row">
              <label>Output</label>
              <input value={output} onChange={(e) => setOutput(e.target.value)} disabled={running} />
              <Btn onClick={pick} disabled={running} tip="Choose where to save">
                Browse…
              </Btn>
              <select value={container} onChange={(e) => setContainer(e.target.value as "mkv" | "mp4")} disabled={running} title="Output container">
                <option value="mkv">MKV</option>
                <option value="mp4">MP4</option>
              </select>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={keepTemp} onChange={(e) => setKeepTemp(e.target.checked)} disabled={running} /> Keep the temporary work folder (for troubleshooting)
            </label>
          </>
        )}

        {(running || error || result) && (
          <div className="progress-box">
            {running && (
              <>
                <div className="progress-bar">
                  <div style={{ width: `${progress.percent.toFixed(1)}%` }} />
                </div>
                <div className="progress-text">
                  {progress.percent.toFixed(0)}% · {progress.message || progress.stage}
                </div>
              </>
            )}
            {error && <div className="warn err">{error}</div>}
            {result && (
              <div className="result">
                <div className="ok">Done. {fmtTime(result.duration, false)} written{result.secondsEncoded > 0 ? `, ${result.secondsEncoded.toFixed(1)} s encoded` : ", nothing re-encoded"}.</div>
                <div className="mono small">{result.output}</div>
                {result.applied.length > 0 && (
                  <table className="applied">
                    <thead>
                      <tr>
                        <th>Edit</th>
                        <th>Asked</th>
                        <th>Actual (keyframes)</th>
                        <th>Card</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.applied.map((a) => (
                        <tr key={a.id}>
                          <td>{KIND_LABEL[a.kind]}</td>
                          <td className="mono">
                            {fmtTime(a.requestedStart, false)} – {fmtTime(a.requestedEnd, false)}
                          </td>
                          <td className="mono">
                            {fmtTime(a.actualStart)} – {fmtTime(a.actualEnd)}
                          </td>
                          <td className="mono">{a.cardSeconds != null ? `${a.cardSeconds.toFixed(2)} s` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {result.warnings.map((w, i) => (
                  <div key={i} className="warn">
                    {w}
                  </div>
                ))}
                <div className="row">
                  <Btn onClick={() => revealInDir(result.output)} tip="Show the file in its folder">
                    Show in folder
                  </Btn>
                  <Btn onClick={() => openPath(result.output)} tip="Open with your default player">
                    Play
                  </Btn>
                </div>
              </div>
            )}
            <div className="row">
              <button className="link" onClick={() => setShowLog((s) => !s)}>
                {showLog ? "Hide" : "Show"} command log
              </button>
            </div>
            {showLog && (
              <pre className="log" ref={logRef}>
                {log.join("\n")}
              </pre>
            )}
          </div>
        )}

        <div className="modal-actions">
          {running ? (
            <Btn danger onClick={() => api.cancelRender()} tip="Stop the render">
              Cancel
            </Btn>
          ) : (
            <Btn onClick={onClose} tip="Close" shortcut="Esc">
              {result ? "Close" : "Back"}
            </Btn>
          )}
          {!result && (
            <Btn primary onClick={start} disabled={!canRun} tip="Write the edited movie" shortcut="Ctrl+R">
              {running ? "Rendering…" : "Render"}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
