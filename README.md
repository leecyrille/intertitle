<p align="center">
  <img src="app-icon.png" width="96" alt="Intertitle icon">
</p>

<h1 align="center">Intertitle</h1>

<p align="center">
  Skip scenes, mute lines and drop in title cards, <b>without re-encoding your movie</b>.<br>
  A Windows desktop app (Tauri) plus a command-line tool. Free and open source.
</p>

<p align="center">
  <a href="https://intertitle.pages.dev">Website</a> ·
  <a href="https://github.com/leecyrille/intertitle/releases">Downloads</a> ·
  <a href="https://pactotech.com/products/intertitle-tip-jar">Leave a tip</a>
</p>

---

Intertitle is for the edit you actually want to make to a film you already own: cut the scene the
kids shouldn't see, mute the one line, and put up a card that says what happened so the story still
makes sense. Just like the intertitles in silent films.

It works on 4K HEVC rips, Dolby Vision, Atmos, 35 subtitle tracks and all, and it does it in a
couple of minutes because **nothing gets re-encoded except the cards themselves**. The movie is split
at keyframes and stream-copied, so there is no quality loss and no waiting hours for an encode.

## What it does

| Edit | Effect | Length |
|---|---|---|
| **Remove** | The range is cut out. | Shorter |
| **Replace with card** | The range is cut out and a text card is shown instead. | Card length of your choice, or exactly the original length |
| **Text over video** | The picture becomes a text card but the audio keeps playing. | Unchanged |
| **Mute** | The audio is silenced; the picture is untouched. | Unchanged |

* Subtitles (SRT, ASS/SSA, WebVTT, mov_text) are retimed to the new timeline and kept. Chapters too.
* Audio is copied as-is: E-AC-3 Atmos, TrueHD, DTS, AAC, FLAC, Opus, whatever the file has. Muted
  sections get real silence in the same codec so nothing else is touched.
* Input: MKV, MP4, MOV, WebM, AVI, TS/M2TS and anything else ffmpeg can read. Output: MKV (keeps
  everything) or MP4.
* Video codecs for cards: H.264, HEVC, AV1, VP9, VP8, MPEG-4, MPEG-2, ProRes, DNxHR. Remove and Mute
  work with any codec.

## Using the app

1. **Open a movie.** Thumbnails fill the scrub bar in the background.
2. **Scrub** to the spot you care about. Click the bar, drag, use the arrow keys (one frame), Shift+arrows
   (one second), Ctrl+arrows (ten seconds). Space plays a low-resolution preview with sound. Press `C`
   to show subtitles on the preview and pick the track in the dropdown.
3. **Mark it.** Press `I` to set the start and `O` to set the end. With nothing selected that creates a new
   edit; with an edit highlighted in the list, the buttons change *that* edit. `N` adds a new edit at the
   playhead.
4. **Choose the action** in the list and type the card text if there is one. Every column is always shown;
   a dash means "does not apply".
5. **Render.** The dialog tells you how long the result will be, how many seconds have to be encoded
   (usually 10 or 20), and where the cuts actually landed.

Hover any button to see what it does and its keyboard shortcut. Press `?` for the full list.

### Edit lists

Edits export to a small CSV next to the movie, named after it (`Movie Name.csv`; the extension is
configurable in Settings). Open the movie again later and the list loads automatically. The format is
plain enough to write by hand:

```csv
start,end,action,text,card_seconds,enabled
00:00:55.000,00:03:36.000,replace,"He just woke up. He can't remember anything from the last long while.",10,yes
01:54:58.000,01:55:35.000,replace,Rocky saved him in the lab.,match,yes
02:12:41.000,02:13:39.000,text-keep-audio,They put him to sleep and made him go.,match,yes
00:40:00.000,00:40:05.000,mute,-,-,yes
00:10:00.000,00:10:30.000,remove,-,-,no
```

Actions: `remove`, `replace`, `text-keep-audio`, `mute`. Times accept `H:MM:SS.mmm`, `MM:SS` or seconds.
`card_seconds` is a number or `match`.

## Command line

The same engine ships as `intertitle-cli`, handy for scripts or a headless box:

```bash
intertitle-cli "Movie.mkv" --edits "Movie.csv"
intertitle-cli "Movie.mkv" --remove 1:02:15-1:03:00 --mute 10:00-10:05 --card 20:00-21:00 "Rocky saved him" --out "Movie (edited).mkv"
intertitle-cli "Movie.mkv" --probe
```

Run it with `--help` for every option.

## Requirements

Intertitle drives two well-known tools. Install them once; the app finds them on your PATH or you can
point to them in Settings.

* **ffmpeg** (with ffprobe): <https://www.gyan.dev/ffmpeg/builds/> or `winget install Gyan.FFmpeg`
* **MKVToolNix** (for mkvmerge): <https://mkvtoolnix.download/> or `winget install MoritzBunkus.MKVToolNix`

## How the no-re-encode trick works

Stream copy can only start on a keyframe, so each cut is snapped to the nearest keyframe (typically within a
second; the render dialog reports the exact points). mkvmerge splits the movie into parts and joins them
back with the cards in between. Cards are rendered with an encoder that matches the movie's codec,
resolution, frame rate, bit depth and colour metadata, and carry their own parameter sets in-band so
players switch cleanly at the joins. Muting works on the audio track alone: it is split at the exact
sample times and the muted piece is swapped for silence in the same codec. Text-over-video works the
same way on the video track alone, with a card that has exactly the same number of frames as the piece
it replaces. Subtitles and chapters are mapped through the resulting timeline.

## Building from source

```bash
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # installer in src-tauri/target/release/bundle
cargo test --manifest-path src-tauri/Cargo.toml -p intertitle-core
cargo build --manifest-path src-tauri/Cargo.toml -p intertitle-core   # the CLI
```

Needs Node 20+, Rust 1.77+, and on Windows the MSVC toolchain (Visual Studio Build Tools with the
"Desktop development with C++" workload) or a full MinGW-w64 (for the GNU toolchain, e.g.
`winget install BrechtSanders.WinLibs.POSIX.UCRT`). `npm run dev` alone opens the UI in a browser with a
mock backend, useful for working on the interface.

The code is split in two: `src-tauri/core` is a plain Rust crate with everything that talks to ffmpeg and
mkvmerge (probing, keyframes, timeline mapping, subtitle retiming, card encoding, the pipeline and the
CLI), and `src-tauri` is the thin Tauri shell around it. The React UI lives in `src/`.

macOS and Linux builds should work with the same commands; they are not tested yet.

## Support the project

Intertitle is free. If it saved you an evening, you can
[leave a tip](https://pactotech.com/products/intertitle-tip-jar) or use
[GitHub Sponsors](https://github.com/sponsors/leecyrille). Stars and bug reports are welcome too.

## License

MIT. ffmpeg and MKVToolNix are separate programs with their own licenses; Intertitle only runs them.
