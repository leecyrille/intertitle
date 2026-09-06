import { useState } from "react";
import { openFile } from "../dialogs";
import type { Settings, ToolStatus } from "../types";
import Btn from "./Btn";

interface Props {
  settings: Settings;
  tools: ToolStatus | null;
  onSave: (s: Settings) => void;
  onClose: () => void;
}

export default function SettingsDialog({ settings, tools, onSave, onClose }: Props) {
  const [s, setS] = useState<Settings>(JSON.parse(JSON.stringify(settings)));
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const setTool = (k: "ffmpeg" | "ffprobe" | "mkvmerge", v: string) => setS({ ...s, tools: { ...s.tools, [k]: v } });
  const setCard = (patch: Partial<Settings["card"]>) => setS({ ...s, card: { ...s.card, ...patch } });

  const browse = async (k: "ffmpeg" | "ffprobe" | "mkvmerge") => {
    const p = await openFile({ title: `Locate ${k}` });
    if (p) setTool(k, p);
  };
  const browseFont = async () => {
    const p = await openFile({ filters: [{ name: "Fonts", extensions: ["ttf", "otf", "ttc"] }] });
    if (p) setCard({ fontFile: p });
  };

  const toolRow = (k: "ffmpeg" | "ffprobe" | "mkvmerge", found?: string | null) => (
    <div className="field-row" key={k}>
      <label>{k}</label>
      <input value={s.tools[k] ?? ""} placeholder={found ? `found: ${found}` : "not found — enter the path to the executable"} onChange={(e) => setTool(k, e.target.value)} />
      <Btn onClick={() => browse(k)} tip={`Pick the ${k} executable`}>
        Browse…
      </Btn>
      <span className={found ? "ok-dot" : "bad-dot"} title={found ? "Found" : "Not found"} />
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <h2>Settings</h2>
        <h3>Tools</h3>
        <p className="dim small">
          Intertitle drives <b>ffmpeg</b>, <b>ffprobe</b> and <b>mkvmerge</b> (MKVToolNix). Leave the fields empty to use the copies found on your PATH.
          {tools?.ffmpegVersion && <span> Detected: {tools.ffmpegVersion.replace(/ Copyright.*$/, "")}.</span>}
          {tools?.mkvmergeVersion && <span> {tools.mkvmergeVersion}.</span>}
        </p>
        {toolRow("ffmpeg", tools?.ffmpeg)}
        {toolRow("ffprobe", tools?.ffprobe)}
        {toolRow("mkvmerge", tools?.mkvmerge)}

        <h3>Title cards</h3>
        <div className="field-row">
          <label>Font file</label>
          <input value={s.card.fontFile} placeholder="platform default (Arial)" onChange={(e) => setCard({ fontFile: e.target.value })} />
          <Btn onClick={browseFont} tip="Pick a TTF/OTF font">
            Browse…
          </Btn>
        </div>
        <div className="field-grid">
          <label>Text size</label>
          <div>
            <input type="range" min={0.02} max={0.12} step={0.005} value={s.card.fontSizeRatio} onChange={(e) => setCard({ fontSizeRatio: Number(e.target.value) })} />
            <span className="mono dim"> {(s.card.fontSizeRatio * 100).toFixed(1)}% of frame height</span>
          </div>
          <label>Text colour</label>
          <input value={s.card.textColor} onChange={(e) => setCard({ textColor: e.target.value })} placeholder="white or #rrggbb" />
          <label>Background</label>
          <input value={s.card.backgroundColor} onChange={(e) => setCard({ backgroundColor: e.target.value })} placeholder="black or #rrggbb" />
          <label>Fade in/out</label>
          <div>
            <input type="number" min={0} max={5} step={0.25} value={s.card.fade} onChange={(e) => setCard({ fade: Number(e.target.value) })} /> <span className="dim">seconds</span>
          </div>
          <label>Encoder preset</label>
          <select value={s.card.preset} onChange={(e) => setCard({ preset: e.target.value })}>
            {["ultrafast", "veryfast", "fast", "medium", "slow"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <label>Default card length</label>
          <div>
            <input type="number" min={0.5} step={0.5} value={s.defaultCardSeconds} onChange={(e) => set({ defaultCardSeconds: Number(e.target.value) || 10 })} /> <span className="dim">seconds</span>
          </div>
        </div>

        <h3>Files</h3>
        <div className="field-grid">
          <label>Output name suffix</label>
          <input value={s.outputSuffix} onChange={(e) => set({ outputSuffix: e.target.value })} placeholder=" (edited)" />
          <label>Edit list extension</label>
          <div>
            <input value={s.csvExtension} onChange={(e) => set({ csvExtension: e.target.value.replace(/^\./, "") })} style={{ width: 90 }} />{" "}
            <span className="dim">exported next to the movie as movie-name.{s.csvExtension || "csv"}</span>
          </div>
          <label>Thumbnails</label>
          <div>
            <input type="number" min={20} max={600} step={10} value={s.thumbnailCount} onChange={(e) => set({ thumbnailCount: Number(e.target.value) || 120 })} />{" "}
            <span className="dim">across the scrub bar (more = slower to build)</span>
          </div>
          <label>Preview width</label>
          <div>
            <input type="number" min={480} max={3840} step={160} value={s.previewWidth} onChange={(e) => set({ previewWidth: Number(e.target.value) || 1280 })} /> <span className="dim">px</span>
          </div>
        </div>

        <div className="modal-actions">
          <Btn onClick={onClose} tip="Discard changes" shortcut="Esc">
            Cancel
          </Btn>
          <Btn primary onClick={() => onSave(s)} tip="Save settings">
            Save
          </Btn>
        </div>
      </div>
    </div>
  );
}
