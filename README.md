# DJ Free 🎧

A free Android DJ app with **automix** — it beat-matches and mixes your songs automatically while you play with the FX.

**Download:** [`release/DJ-Free.apk`](release/DJ-Free.apk) → open it on your phone → allow "Install unknown apps" → install.
(Android 7.0+, landscape.)

## Features

**Automix**
- Analyses BPM, beat grid, musical key (Camelot) and intro/outro of every track
- Tempo-syncs the next track and starts it on the downbeat, phrase-aligned
- 9 transition styles: Smart (auto-pick), EQ bass swap, smooth fade, filter sweep, echo out, reverb wash, spinback, tape stop, cut
- Transition length 4–64 beats, skip silence, shuffle, harmonic (key + tempo) ordering
- Tempo glides back to the original after each mix; *Mix now* / *Skip* buttons; queue editor
- You can grab any knob, fader or FX while automix runs

**Decks & mixer**
- 2 decks, scrolling 3-band colour waveforms with beat grid + track overview (tap to seek)
- Jog wheels with vinyl scratch / pitch-bend; scratch on the waveform too
- Sync, pitch ±4/8/16/50 %, pitch bend, key lock (master tempo), key shift ±3 st + key match
- Hot cues ×8, auto loops 1/4–32 beats, loop in/out, halve/double, reloop, loop roll, beat jump, slip mode, quantize
- 3-band EQ with kills (long-press), gain, filter (LPF/HPF), channel faders, VU meters, crossfader with 3 curves
- Master volume + limiter, split-cue headphone mode (L = master, R = cue with a splitter cable)

**FX** — 3 slots per deck, beat-synced (1/8 – 4 beats), XY pad
Echo, Ping Pong, Reverb, Flanger, Phaser, Chorus, Trance Gate, Auto Filter, Wah, LP Filter, HP Filter, Bitcrusher,
Distortion, Lo-Fi, Auto Pan, Tremolo, Ring Mod, Pitch Shift, Noise Sweep, Spiral, Punch (compressor), Stereo Wide.
**Performance FX:** Brake, Spinback, Reverse, Censor, Echo Out, Wash Out, Stutter, Kill All.

**Also:** 8-pad sampler (air horn, siren, riser, impact…), mix recording (saved to `Music/DJ Free`), 4 built-in demo tracks.

## Apple Music

- **Search** the Apple Music catalog with no account and load any song onto a deck (30-second preview).
- **Connect your account** (Settings → Apple Music) to browse *your* library and playlists. This uses Apple's MusicKit and
  needs a MusicKit **developer token** (requires an Apple Developer Program membership —
  [how to create one](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)).

> ⚠️ **Honest limitation:** full-length Apple Music songs are FairPlay DRM-protected. Apple does not let third-party apps
> feed those streams into their own audio engine, so no app outside Apple's own partner deals can beat-match, EQ or put FX
> on full Apple Music tracks. DJ Free therefore mixes the **30-second previews** of Apple Music songs. For full-length
> mixing, add audio files you own under **Library → My Files** (MP3, M4A/AAC, WAV, FLAC, OGG).

## How it's built

- `app/src/main/java/.../MainActivity.java` — native shell: WebView served from a virtual HTTPS origin, file picker,
  Apple preview proxy, MusicKit sign-in popup, saving recordings.
- `app/src/main/assets/www/` — the DJ engine on the Web Audio API:
  - `js/worklets.js` – AudioWorklet deck player (scratch, brake, loops, slip, sample-accurate scheduled starts), key-lock pitch shifter, bitcrusher
  - `js/analysis-worker.js` – BPM/beat-grid, key detection, waveform peaks, mix points
  - `js/engine.js` – decks, mixer, master bus, sampler, recorder
  - `js/fx.js` – effects · `js/automix.js` – automix · `js/ui.js` – interface

### Build it yourself

```bash
# needs JDK 17+ and the Android SDK (platform 34)
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

Every push also builds the APK in GitHub Actions (artifact `DJ-Free-apk`).
The APK is signed with the project key in `keystore/` so updates install over older versions; use your own key if you
ever publish it to a store.

To try the UI in a desktop browser: `python3 -m http.server -d app/src/main/assets/www` and open http://localhost:8000.
