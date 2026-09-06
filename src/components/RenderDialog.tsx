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
      const res = await api.render({ path: media.path, edits: enabled, output, container, style: settings.card, keepTemp: false });
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
        <h2>Make the edited movie</h2>
        {!result && (
          <>
            <div className="summary">
              <div>
                <b>{enabled.length}</b> edit{enabled.length === 1 ? "" : "s"} will be applied
                {enabled.length > 0 && (
                  <span className="dim">
                    {" "}
                    ({Object.entries(
                      enabled.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {})
                    )
                      .map(([k, n]) => `${n} × ${KIND_LABEL[k as Edit["kind"]].toLowerCase()}`)
                      .join(", ")}
                    )
                  </span>
                )}
              </div>
              <div>
                The movie goes from {fmtTime(media.duration, false)} to about <b>{fmtTime(outputLength(edits, media.duration), false)}</b>
                {removed > 0 && <span className="dim"> ({fmtTime(removed, false)} cut)</span>}
              </div>
              <div>
                {encodeSeconds > 0 ? (
                  <>
                    Only the cards are encoded (<b>{encodeSeconds.toFixed(0)} seconds</b> in total). The rest of the movie is copied exactly as it is.
                  </>
                ) : (
                  <>Nothing is re-encoded. The movie is copied exactly as it is, minus your edits.</>
                )}
              </div>
            </div>
            <div className="warn-list">
              {!tools?.mkvmerge && <div className="warn err">MKVToolNix was not found. It does the cutting and joining. Install it or set its location in Settings.</div>}
              {!tools?.ffmpeg && <div className="warn err">ffmpeg was not found. Install it or set its location in Settings.</div>}
              {missingText.length > 0 && <div className="warn err">{missingText.length} card{missingText.length > 1 ? "s have" : " has"} no text yet. Type something in the "Card says" column.</div>}
              {timelineChanges && imageSubs.length > 0 && (
                <div className="warn">
                  {imageSubs.length} picture-based subtitle track{imageSubs.length > 1 ? "s" : ""} ({imageSubs.map((s) => s.codec).join(", ")}) will be left out because the
                  running time changes. Text subtitles are kept and retimed.
                </div>
              )}
              {timelineChanges && <div className="warn info">Cuts land on the nearest clean cut point in the video (a keyframe), usually within a second of the time you chose. You will see the exact times when it's done.</div>}
              {container === "mp4" && <div className="warn info">MP4 keeps text subtitles and chapters. Pick MKV to keep every kind of subtitle.</div>}
            </div>
            <div className="field-row">
              <label>Save as</label>
              <input value={output} onChange={(e) => setOutput(e.target.value)} disabled={running} />
              <Btn onClick={pick} disabled={running} tip="Choose a different name or folder">
                Change…
              </Btn>
              <select value={container} onChange={(e) => setContainer(e.target.value as "mkv" | "mp4")} disabled={running} title="File type">
                <option value="mkv">MKV file</option>
                <option value="mp4">MP4 file</option>
              </select>
            </div>
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
                <div className="ok">
                  Done. The edited movie is {fmtTime(result.duration, false)} long{result.secondsEncoded > 0 ? ` and only ${result.secondsEncoded.toFixed(0)} seconds of it were encoded` : " and nothing was re-encoded"}.
                </div>
                <div className="mono small">{result.output}</div>
                {result.applied.length > 0 && (
                  <table className="applied">
                    <thead>
                      <tr>
                        <th>Edit</th>
                        <th>You asked for</th>
                        <th>Actual cut</th>
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
                          <td className="mono">{a.cardSeconds != null ? `${a.cardSeconds.toFixed(1)} s` : "—"}</td>
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
                  <Btn primary onClick={() => openPath(result.output)} tip="Open it in your usual video player">
                    ▶ Play the edited movie
                  </Btn>
                  <Btn onClick={() => revealInDir(result.output)} tip="Open the folder it was saved in">
                    Show the file
                  </Btn>
                </div>
              </div>
            )}
            <div className="row">
              <button className="link" onClick={() => setShowLog((s) => !s)}>
                {showLog ? "Hide" : "Show"} technical details
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
            <Btn danger onClick={() => api.cancelRender()} tip="Stop now. Nothing is changed in the original movie.">
              Stop
            </Btn>
          ) : (
            <Btn onClick={onClose} tip="Close" shortcut="Esc">
              {result ? "Close" : "Back"}
            </Btn>
          )}
          {!result && (
            <Btn primary onClick={start} disabled={!canRun} tip="Write the edited movie as a new file. The original is never changed.">
              {running ? "Working…" : "Make the edited movie"}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
