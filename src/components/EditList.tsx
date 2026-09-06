import { useEffect, useRef, useState } from "react";
import { fmtTime, KIND_HELP, KIND_LABEL, KIND_ORDER, parseTime, type Edit, type EditKind } from "../types";
import Btn from "./Btn";

interface Props {
  edits: Edit[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Edit>) => void;
  onDelete: (id: string) => void;
  onSeek: (t: number) => void;
  duration: number;
  defaultCardSeconds: number;
}

function TimeCell({ value, onCommit, max }: { value: number; onCommit: (v: number) => void; max: number }) {
  const [text, setText] = useState(fmtTime(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmtTime(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const v = parseTime(text);
    if (v === null || v < 0 || v > max) {
      setText(fmtTime(value));
      return;
    }
    if (Math.abs(v - value) > 0.0005) onCommit(v);
  };
  return (
    <input
      className={`cell-input mono ${editing ? "editing" : ""}`}
      value={text}
      onFocus={(e) => {
        setEditing(true);
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(fmtTime(value));
          setEditing(false);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      title="H:MM:SS.mmm  (Enter to apply)"
    />
  );
}

function TextCell({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = Math.min(el.scrollHeight, 96) + "px";
    }
  }, [text]);
  return (
    <textarea
      ref={ref}
      className="cell-input text"
      rows={1}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        e.stopPropagation();
      }}
      title="Card text. Shift+Enter for a new line. Long lines wrap automatically."
    />
  );
}

export default function EditList(p: Props) {
  const dash = <span className="dash">—</span>;
  return (
    <div className="editlist">
      <table>
        <thead>
          <tr>
            <th className="c-num">#</th>
            <th className="c-on" title="Include this edit when rendering">
              On
            </th>
            <th className="c-type">Type</th>
            <th className="c-time">Start</th>
            <th className="c-time">End</th>
            <th className="c-len">Length</th>
            <th className="c-text">Card text</th>
            <th className="c-card">Card length</th>
            <th className="c-act"></th>
          </tr>
        </thead>
        <tbody>
          {p.edits.length === 0 && (
            <tr className="empty">
              <td colSpan={9}>
                No edits yet. Scrub to a spot and press <kbd>I</kbd> to start one, <kbd>O</kbd> to end it. Or click <b>+ New edit</b>.
              </td>
            </tr>
          )}
          {p.edits.map((e, i) => {
            const sel = e.id === p.selectedId;
            const hasText = e.kind === "replace" || e.kind === "textOverVideo";
            return (
              <tr
                key={e.id}
                className={`${sel ? "selected" : ""} ${e.enabled ? "" : "off"} kind-${e.kind}`}
                onClick={() => p.onSelect(e.id)}
                onDoubleClick={() => p.onSeek(e.start)}
              >
                <td className="c-num mono">{i + 1}</td>
                <td className="c-on">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={(ev) => p.onChange(e.id, { enabled: ev.target.checked })}
                    onClick={(ev) => ev.stopPropagation()}
                  />
                </td>
                <td className="c-type">
                  <select
                    className={`kind-select ${e.kind}`}
                    value={e.kind}
                    onChange={(ev) => p.onChange(e.id, { kind: ev.target.value as EditKind })}
                    onClick={(ev) => ev.stopPropagation()}
                    title={KIND_HELP[e.kind]}
                  >
                    {KIND_ORDER.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="c-time">
                  <TimeCell
                    value={e.start}
                    max={p.duration}
                    onCommit={(v) => p.onChange(e.id, { start: v, end: v >= e.end ? Math.min(v + p.defaultCardSeconds, p.duration) : e.end })}
                  />
                </td>
                <td className="c-time">
                  <TimeCell value={e.end} max={p.duration} onCommit={(v) => p.onChange(e.id, { end: v, start: v <= e.start ? Math.max(v - p.defaultCardSeconds, 0) : e.start })} />
                </td>
                <td className="c-len mono dim">{fmtTime(e.end - e.start, true).replace(/^00:/, "")}</td>
                <td className="c-text">
                  {hasText ? (
                    <TextCell value={e.text} onCommit={(v) => p.onChange(e.id, { text: v })} placeholder={e.kind === "replace" ? "What the card should say…" : "Text shown while the audio plays…"} />
                  ) : (
                    dash
                  )}
                </td>
                <td className="c-card">
                  {e.kind === "replace" ? (
                    <div className="card-len" onClick={(ev) => ev.stopPropagation()}>
                      <select value={e.durationMode} onChange={(ev) => p.onChange(e.id, { durationMode: ev.target.value as Edit["durationMode"] })} title="How long the card is shown">
                        <option value="fixed">Seconds</option>
                        <option value="match">Match original</option>
                      </select>
                      {e.durationMode === "fixed" ? (
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          value={e.duration}
                          onChange={(ev) => p.onChange(e.id, { duration: Math.max(0.5, Number(ev.target.value) || 0.5) })}
                          title="Card length in seconds"
                        />
                      ) : (
                        <span className="mono dim">{(e.end - e.start).toFixed(1)}s</span>
                      )}
                    </div>
                  ) : e.kind === "textOverVideo" ? (
                    <span className="mono dim" title="Same as the original, so the audio stays in sync">
                      = {(e.end - e.start).toFixed(1)}s
                    </span>
                  ) : (
                    dash
                  )}
                </td>
                <td className="c-act" onClick={(ev) => ev.stopPropagation()}>
                  <Btn small onClick={() => p.onSeek(e.start)} tip="Jump to start" shortcut="[">
                    ⇤
                  </Btn>
                  <Btn small onClick={() => p.onSeek(e.end)} tip="Jump to end" shortcut="]">
                    ⇥
                  </Btn>
                  <Btn small danger onClick={() => p.onDelete(e.id)} tip="Delete this edit" shortcut="Del">
                    ✕
                  </Btn>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
