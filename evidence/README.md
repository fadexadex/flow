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

## phase-1-audio

Audio import, which every earlier round concluded was impossible in this build.

| File | Shows |
| ---- | ----- |
| `audio-works-proof.png` | a `.wav` in the dock, surviving a boot scan, the six-sample suite, and the running game |
| `audio-playing-in-game.mp4` | the game playing all six imported samples |
| `findings.json` | the driver in use, the imported files as the project sees them, and the export |
| `audio_works.zip` | the exported project, six `.wav` files included |

**The limitation was ours.** The editor was booted with `--audio-driver Dummy` so an editor
AudioContext could not race the game's. Godot's audio import builds a waveform preview by
mixing the stream through `AudioServer`; a Dummy driver returns a zero-length preview, and the
editor then indexes it at -1 and aborts the runtime. Booting with `AudioWorklet` instead:

- a `.wav` imports, `loadable: true`, and appears in the FileSystem dock with its audio icon;
- a cold page opening a project that already contains one boots healthy — the exact case that
  used to abort;
- `godot_synthesize_audio_suite` reports `imported_ok: 6`, every sample with import metadata;
- the running game loads all six as `AudioStreamWAV` and plays them;
- the export contains them.

Four game run/stop cycles on the real driver showed none of the AudioWorkletNode contention the
Dummy flag was guarding against: `healthy`, 0 project errors, 0 fatals on every cycle.

### phase-1-audio-audible

`audio-playing-in-game.mp4` in the folder above was captured with `canvas.captureStream()`,
which carries video only — it is silent, and a silent video is not evidence of audio. This
folder answers the question properly by measuring the signal instead of the intent.

`findings.json` is an `AnalyserNode` tapped onto Godot's master bus while the six samples play:

| Measure | Value |
| ------- | ----- |
| AudioContext state | `running` |
| Peak RMS on the master bus | 0.775 (**-2.2 dBFS**) |
| Frames above the noise floor | 22 of 793 sampled at 40 ms — one burst per sample |
| Driver / output | `AudioWorklet` / `Default` |

`godot_start_recording` does mix the master bus into the capture (`audio_tracks: 1`,
`video/webm;codecs=vp8,opus`); the ad-hoc recorder used for the other clips did not.

One browser rule applies and is not ours to fix: an `AudioContext` cannot start without a user
gesture, so a page that has never been clicked produces no sound however correct the project
is. The context reported `running` here only after a real click.

## phase-2-collision

`godot_node_body` — physics in the live mutator, so a game no longer needs hand-written scene
text for a floor.

| File | Shows |
| ---- | ----- |
| `01-bodies-placed.png` | the persisted physics-body subtrees in the real Godot editor |
| `02-bodies-at-rest-in-game.png` | the same scene running with both rigid bodies at rest |
| `collision-bodies-clean.webm` | a fresh 6.5 s playtest recording with one audio track |
| `findings.json` | structured body creation, rest positions, overlaps and clean session health |

A `StaticBody3D` floor, two `RigidBody3D` props and an `Area3D` trigger, each through the
command channel with no editor restart, `source_synced: true` and `persisted: true`.

The clean proof is where the bodies stopped: the crate fell from y=8 to **y=0.99** and the ball
from y=12 to **y=1.09** — each exactly its half-extent above the floor's top face. Both report
`sleeping=true`, the `Area3D` reports three overlaps, and the session reports **0 project
errors, 0 warnings and 0 fatals**.

## phase-3-tools

The five tools that reported "unsupported": three made real, two retired. The catalog no longer
contains a stub.

| File | Shows |
| ---- | ----- |
| `stub-tools-proof.png` | workspace switching, property setting with read-back, and a connected signal firing in the running game |

- `godot_switch_mode` switches 2D / Script / 3D and confirms each by reading back the visible
  editor control (`@CanvasItemEditor@`, `@ScriptEditor@`, `@Node3DEditor@`).
- `godot_connect_signal_live` refuses a missing handler (*"OrbitalSanctuary has no method
  '_on_nothing'"*) and a missing signal (*"Area3D has no signal 'not_a_signal'"*), then makes
  the real connection: editor-confirmed, `source_synced: true`, `[connection]` written at the
  end of the scene text, and **the running game logs `gate entered by BotanistPlayer total=1`**.
- `godot_node_set_property` sets `light_energy` 1.8 → 4.5, a colour and a bool, each read back
  off the node; refuses a resource-valued property and an unknown name by name.

Fixed along the way: a rejection from the editor was being reported as *"not connected to an
acknowledged Godot Editor command channel"* — which was not true, and hid the actual reason.

## phase-4-hot-scenes

Scene and resource writes that no longer replace the editor.

| File | Shows |
| ---- | ----- |
| `hot-scene-writes-proof.png` | a `.tscn` written live and then instanced |

A new `landing_pad.tscn` written into the running editor in **999 ms** with
`editor_restarted: false` — the same write used to cost a ~4 s editor replacement. What makes
it publishable is Godot's own answer, not the write: `loadable: true`,
`resource_class: PackedScene`, `can_instantiate: true`, `root_name: LandingPad`,
`node_count: 3`. It was then instanced straight away, both children present.

The two refusals matter as much:

- Writing `orbital_sanctuary.tscn`, the scene the editor **has open**, did not take the hot
  path — it replaced the editor (6.0 s), because reloading it would discard the live tree and
  the undo history.
- A scene with a dangling `SubResource` was **refused**: *"Godot wrote res://broken.tscn but
  could not load it."* The hash matched; the load is what caught it.

## phase-5-deploy-policy

One serving policy for all three targets, replacing three hand-written copies that had already
drifted apart.

`served-headers.txt` is `curl -I` against the running Node server after the change.

The drift was real, and local development was the worst-served of the three: the Node server
sent **no** cache-control or content-type rules at all, so a stale `mcp_bridge.js` against a
fresh page was possible locally and not in production. Vercel never sent
`Access-Control-Allow-Methods` or `-Headers`. Both are fixed by construction now — the config
files are generated, and `npm test` fails if the checked-in ones stop matching.

Verified in the page afterwards: `crossOriginIsolated: true`, SharedArrayBuffer available,
55 tools on `/api/mcp/tools`, editor healthy with 0 project errors.

## phase-6-2d

The live mutator was 3D only. Now it is not.

| File | Shows |
| ---- | ----- |
| `live-2d-proof.png` | the 2D template, seven live 2D operations, and the game running |
| `arcade-2d-playing.mp4` | the runner responding to input in the running 2D game |

`godot_create_project` gains an `arcade_2d` template — a Camera2D, a `StaticBody2D` ground and
a `CharacterBody2D` runner with movement, so a 2D game has somewhere to start.
`godot_node_spawn_2d` and `godot_node_body_2d` add rects, labels, polygons, lines, sprites and
the four 2D body types, 1–2 ms each. `godot_node_transform` now asks the editor which dimension
the node is rather than assuming 3D.

Two things stated rather than hidden:

- A live 2D edit reports `source_synced: false` and `persisted: false`. The bridge serializes
  3D scene text, not 2D, so the node is real in the editor and not in the `.tscn`. That is why
  the live-added platforms are absent from the running game in frame 3 — the game runs the
  saved scene, and the tool said so.
- Fixed during this phase: the 2D tools were bumping the scene revision without changing any
  file, which left every session permanently `degraded` with nothing to persist and made the
  next transaction's `expected_revision` wrong.

## phase-7-url-import

Assets from a URL or a dropped file, not only from base64 an agent had to carry.

| File | Shows |
| ---- | ----- |
| `url-import-proof.png` | a model fetched from GitHub, imported and instanced |
| `ssrf-guards.txt` | what the proxy refuses, and what it serves, against the running server |

The page cannot fetch a third-party asset itself: it is cross-origin isolated, so a response
without a `Cross-Origin-Resource-Policy` header never reaches JavaScript. The server fetches it
instead — which makes this an SSRF surface, and it is treated as one. Refused, live:

- `http://169.254.169.254/...` — the cloud metadata service, the reason this matters
- `http://127.0.0.1:8100/...` — loopback, and any private range
- `file:///etc/passwd` — only http and https
- `https://example.com/index.html` — the URL must name an asset extension Godot can import

Redirects are followed by hand so each hop is re-checked. Two real bugs were caught by the
tests while writing it: `URL` keeps the brackets on an IPv6 literal, so `[::1]` was refused for
the wrong reason; and it normalises `[::ffff:10.0.0.1]` to `[::ffff:a00:1]`, so a private IPv4
in v6 clothing walked straight through until the mapped form was unwrapped properly.

Measured: Khronos `Box.glb` fetched and imported in **991 ms**, `loadable: true`, `source_url`
recorded in the result, included in the export, and instanced into the scene straight after.

`proxy-hardening.txt` records the follow-up hardening: the connection is pinned to the exact
public IP that passed validation, redirects are re-resolved and re-pinned, and the 5 MiB limit
is enforced while streaming rather than after buffering.

## submission-validation

A fresh agent-driven 3D run across the complete submission path. It created a project, added
physics, imported and instanced a public GLB, generated six loadable WAV files, hot-compiled
project telemetry, launched and observed the real playtest, captured a recording, survived a
page reload with automatic project restoration, and exported a 14-file ZIP with provenance.

The final timed-input check waits through key release and returns fresh runtime telemetry in
the same call: ArrowUp moved the player from z=52.0 to z=45.4 before the response, then to
z=42.7 in the following sample. The complete automated suite passes 268/268 with catalog
parity across all 57 tools.

`findings.json` is the compact result and `flow_submission_validation_3d.zip` is the exported
project. The final session was healthy with 0 project errors, 0 warnings and 0 fatals.
