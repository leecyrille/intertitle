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
    const p = await openFile({ title: `Find ${k}` });
    if (p) setTool(k, p);
  };
  const browseFont = async () => {
    const p = await openFile({ filters: [{ name: "Fonts", extensions: ["ttf", "otf", "ttc"] }] });
    if (p) setCard({ fontFile: p });
  };

  const toolRow = (k: "ffmpeg" | "ffprobe" | "mkvmerge", found?: string | null) => (
    <div className="field-row" key={k}>
      <label>{k}</label>
      <input value={s.tools[k] ?? ""} placeholder={found ? `found: ${found}` : "not found — pick the program file"} onChange={(e) => setTool(k, e.target.value)} />
      <Btn onClick={() => browse(k)} tip={`Pick the ${k} program file`}>
        Find…
      </Btn>
      <span className={found ? "ok-dot" : "bad-dot"} title={found ? "Found" : "Not found"} />
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <h2>Settings</h2>
        <h3>Helper programs</h3>
        <p className="dim small">
          Intertitle uses <b>ffmpeg</b> (with ffprobe) and <b>mkvmerge</b> from MKVToolNix. Leave these empty if they were found; otherwise point at the program files.
          {tools?.ffmpegVersion && <span> Found {tools.ffmpegVersion.replace(/ Copyright.*$/, "")}.</span>}
          {tools?.mkvmergeVersion && <span> Found {tools.mkvmergeVersion}.</span>}
        </p>
        {toolRow("ffmpeg", tools?.ffmpeg)}
        {toolRow("ffprobe", tools?.ffprobe)}
        {toolRow("mkvmerge", tools?.mkvmerge)}

        <h3>How cards look</h3>
        <div className="field-row">
          <label>Font</label>
          <input value={s.card.fontFile} placeholder="Arial (default)" onChange={(e) => setCard({ fontFile: e.target.value })} />
          <Btn onClick={browseFont} tip="Pick a font file (.ttf or .otf)">
            Find…
          </Btn>
        </div>
        <div className="field-grid">
          <label>Text size</label>
          <div>
            <input type="range" min={0.03} max={0.1} step={0.005} value={s.card.fontSizeRatio} onChange={(e) => setCard({ fontSizeRatio: Number(e.target.value) })} />
            <span className="dim"> {s.card.fontSizeRatio < 0.045 ? "small" : s.card.fontSizeRatio < 0.065 ? "normal" : "large"}</span>
          </div>
          <label>Text colour</label>
          <input value={s.card.textColor} onChange={(e) => setCard({ textColor: e.target.value })} placeholder="white" />
          <label>Background</label>
          <input value={s.card.backgroundColor} onChange={(e) => setCard({ backgroundColor: e.target.value })} placeholder="black" />
          <label>Fade in and out</label>
          <div>
            <input type="number" min={0} max={5} step={0.25} value={s.card.fade} onChange={(e) => setCard({ fade: Number(e.target.value) })} /> <span className="dim">seconds</span>
          </div>
          <label>Cards usually last</label>
          <div>
            <input type="number" min={0.5} step={0.5} value={s.defaultCardSeconds} onChange={(e) => set({ defaultCardSeconds: Number(e.target.value) || 10 })} /> <span className="dim">seconds</span>
          </div>
        </div>

        <h3>Files</h3>
        <div className="field-grid">
          <label>Edited movie name ends with</label>
          <input value={s.outputSuffix} onChange={(e) => set({ outputSuffix: e.target.value })} placeholder=" (edited)" />
          <label>Edit list file type</label>
          <div>
            <input value={s.csvExtension} onChange={(e) => set({ csvExtension: e.target.value.replace(/^\./, "") })} style={{ width: 90 }} />{" "}
            <span className="dim">saved next to the movie as movie-name.{s.csvExtension || "csv"}</span>
          </div>
        </div>

        <div className="modal-actions">
          <Btn onClick={onClose} tip="Close without saving" shortcut="Esc">
            Cancel
          </Btn>
          <Btn primary onClick={() => onSave(s)} tip="Keep these settings">
            Save
          </Btn>
        </div>
      </div>
    </div>
  );
}
