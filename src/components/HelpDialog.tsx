import { openUrl } from "../dialogs";
import Btn from "./Btn";
import { LINKS } from "../links";

const SHORTCUTS: [string, string][] = [
  ["Ctrl+O", "Open a movie"],
  ["Space", "Play / pause the preview"],
  ["← / →", "Step one frame"],
  ["Shift+← / →", "Step 1 second"],
  ["Ctrl+← / →", "Step 10 seconds"],
  ["Home / End", "Go to the start / end"],
  ["I", "Set the selected edit's start here (or start a new edit)"],
  ["O", "Set the selected edit's end here (or finish the new edit)"],
  ["N", "New edit at the playhead"],
  ["[ / ]", "Jump to the selected edit's start / end"],
  ["↑ / ↓", "Select the previous / next edit"],
  ["1 2 3 4", "Change the selected edit to Remove / Card / Text over video / Mute"],
  ["Delete", "Delete the selected edit"],
  ["Esc", "Deselect"],
  ["C", "Toggle subtitles on the preview"],
  ["Ctrl+E", "Export the edit list (CSV)"],
  ["Ctrl+I", "Import an edit list"],
  ["Ctrl+R", "Render"],
  ["?", "This help"],
];

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal help">
        <h2>How Intertitle works</h2>
        <p>
          Open a movie, scrub to the spot you want to change and add an edit. Each edit is a range with an action:
        </p>
        <ul>
          <li>
            <b>Remove</b> cuts the range out.
          </li>
          <li>
            <b>Replace with card</b> cuts the range out and shows a text card instead, for as long as you like or exactly as long as the original.
          </li>
          <li>
            <b>Text over video</b> keeps the audio and replaces only the picture with a card, so the length never changes.
          </li>
          <li>
            <b>Mute</b> keeps the picture and silences the sound.
          </li>
        </ul>
        <p>
          The <b>selected edit</b> (highlighted in the list) is what the <b>Set start</b> and <b>Set end</b> buttons change. With nothing selected they create a new edit. Nothing is
          re-encoded except the cards themselves: the movie is split at keyframes and stream-copied, so a 4K film renders in a couple of minutes and loses no quality. Subtitles and
          chapters are retimed to match.
        </p>
        <h3>Keyboard shortcuts</h3>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Support the project</h3>
        <p className="dim small">Intertitle is free and open source. If it saved you an evening, a tip keeps it going.</p>
        <div className="row wrap">
          <Btn onClick={() => openUrl(LINKS.tipJar)} tip="Leave a tip (Shopify)">
            ☕ Leave a tip
          </Btn>
          <Btn onClick={() => openUrl(LINKS.sponsors)} tip="GitHub Sponsors">
            ♥ GitHub Sponsors
          </Btn>
          <Btn onClick={() => openUrl(LINKS.repo)} tip="Source code, issues and releases">
            ★ GitHub
          </Btn>
          <Btn onClick={() => openUrl(LINKS.site)} tip="Project website">
            Website
          </Btn>
        </div>
        <div className="modal-actions">
          <Btn primary onClick={onClose} tip="Close" shortcut="Esc">
            Close
          </Btn>
        </div>
      </div>
    </div>
  );
}
