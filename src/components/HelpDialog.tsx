import { openUrl } from "../dialogs";
import Btn from "./Btn";
import { LINKS } from "../links";

const SHORTCUTS: [string, string][] = [
  ["Ctrl+O", "Open a movie"],
  ["Space", "Play / pause the preview"],
  ["← / →", "Step one frame (mouse wheel over the picture does the same)"],
  ["Shift+← / →", "Step 1 second"],
  ["Ctrl+← / →", "Step 10 seconds"],
  ["Home / End", "Go to the start / end"],
  ["I", "Start here: sets the highlighted edit's start, or starts a new edit"],
  ["O", "End here: sets the highlighted edit's end, or finishes the new edit"],
  ["N", "Add another edit at the playhead"],
  ["[ / ]", "Jump to the highlighted edit's start / end"],
  ["↑ / ↓", "Highlight the previous / next edit"],
  ["1 2 3 4", "Change the highlighted edit: cut it out / cut + card / card + sound / mute"],
  ["Delete", "Remove the highlighted edit"],
  ["Esc", "Un-highlight"],
  ["C", "Subtitles on / off"],
  ["Ctrl+S", "Save the edit list"],
  ["Ctrl+L", "Load an edit list"],
  ["Ctrl+Enter", "Make the edited movie"],
  ["?", "This help"],
];

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal help">
        <h2>How Intertitle works</h2>
        <p>Open a movie, scrub to the part you want to change, and add an edit. Each edit covers a stretch of the movie and does one of four things:</p>
        <ul>
          <li>
            <b>Cut it out</b>: that part is gone.
          </li>
          <li>
            <b>Cut it out, show a card</b>: that part is gone and a card with your words is shown instead, for a few seconds or for as long as the cut part.
          </li>
          <li>
            <b>Show a card, keep the sound</b>: the picture becomes a card but the sound keeps playing, so nothing changes length.
          </li>
          <li>
            <b>Mute the sound</b>: the picture stays, the sound goes quiet.
          </li>
        </ul>
        <p>
          <b>Start here</b> and <b>End here</b> change whichever edit is highlighted in the list. With nothing highlighted they begin a new edit. When you are happy, click{" "}
          <b>Make the edited movie</b>: the original file is never touched, and only the cards are encoded, so even a 4K film is done in a couple of minutes with no loss of
          quality. Subtitles and chapters are kept and retimed.
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
          <Btn onClick={() => openUrl(LINKS.tipJar)} tip="Leave a tip">
            ☕ Leave a tip
          </Btn>
          <Btn onClick={() => openUrl(LINKS.sponsors)} tip="GitHub Sponsors">
            ♥ GitHub Sponsors
          </Btn>
          <Btn onClick={() => openUrl(LINKS.site)} tip="Project website">
            Website
          </Btn>
          <Btn onClick={() => openUrl(LINKS.repo)} tip="Source code, bug reports">
            Source code
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
