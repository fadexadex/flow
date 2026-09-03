# Evidence

Recorded live against the browser-hosted Godot 4.7.2 editor, one folder per phase of the
"close the FLow limitations" work. Every image is a real `godot_capture_viewport` frame and
every video is a real `MediaRecorder` capture of the editor or game canvas — neither is a
mock-up or a reconstruction.

`findings.json` files carry the raw tool output the images illustrate, so a claim in a caption
can be checked against what the editor actually reported.

## phase-0-diagnostics

What this build can and cannot do, measured rather than assumed.

| File | Shows |
| ---- | ----- |
| `findings.json` | `audio_capability` and `open_scenes` output, plus both camera experiments |
| `camera-input-proof.png` | orbit and dolly moving the camera with the page unfocused; the same route with a key doing nothing |
| `camera-control-unfocused.mp4` | 18 s of orbit / dolly / pan driven entirely from tool calls, page unfocused throughout |

Findings:

- **The WAV, Ogg and MP3 importers are all registered** (`importer_classes` all true). The
  "the importer is missing" theory for the audio abort is dead.
- `AudioStreamWAV/OggVorbis/MP3` all expose `load_from_buffer`, so a resource can be built
  in-engine without the import path.
- `AudioStreamPreviewGenerator` is present and the editor runs with `audio_driver: "Dummy"` —
  the preview generator mixes through `AudioServer`, which is the current best explanation for
  an empty preview buffer and the `Index p_index = -1 ... size() = 0` abort.
- **Keyboard shortcuts cannot be delivered to the editor from a tool.** Not by DOM key event
  (a browser sends no keys to an unfocused document), not by `emit_signal("gui_input")`
  (`Control._gui_input` is a virtual the engine calls, not a signal handler), and not by
  `Viewport.push_input` (which routes keys by GUI focus). **Mouse events work by all of the
  last route**, because the viewport routes them by position.

## phase-0-camera

`godot_camera_focus` rebuilt on that finding: a closed loop that pans and dollies the viewport
and re-reads the real camera pose between corrections.

| File | Shows |
| ---- | ----- |
| `camera-framing-proof.png` | four framings, page unfocused, with the reported status under each |
| `camera-focus-unfocused-page.mp4` | the same four, as recorded video |

`document.hasFocus() === false` for all of it. Two targets moved and were reached; two were
already framed and say so (`already_framed: true`) rather than reporting a camera that refused
to move. Zero project errors, zero fatals.
