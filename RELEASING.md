# Releasing

How the installers are built, how to cut a release, and what to do when
something in the packaging needs changing.

## What ships

Three installers, each self-contained. A user needs nothing on their machine —
no Python, no ffmpeg, no terminal.

| Platform | Asset | Size |
| --- | --- | --- |
| macOS 11+, Apple Silicon | `TaylorsTranscriber-<ver>-arm64.dmg` | ~52 MB |
| Windows 10/11, 64-bit | `TaylorsTranscriber-<ver>-setup.exe` | ~50 MB |
| Linux, x86_64, glibc 2.28+ | `TaylorsTranscriber-<ver>-x86_64.AppImage` | ~350 MB |

Each contains a complete CPython, the base dependencies pre-installed, the app
sources, and a small purpose-built ffmpeg. The Linux one is much larger because
it also carries Qt and its WebEngine — see [Linux](#linux) below.

## Why an interpreter and not a frozen binary

`bootstrap.install_packages_streaming` runs `sys.executable -m pip install` so
the Settings panel can add speech runtimes on a button click, and `audio_tools`
shells out to `sys.executable -m demucs`. PyInstaller and py2app produce a
binary with neither pip nor a usable `venv`, so freezing would take that feature
away and put the terminal back in the setup.

So the installers ship a real, relocatable CPython from
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
and the existing architecture is left intact. The app still creates its own
environment in the user's application-support directory and still extends it on
demand. The only change is that the interpreter it starts from is the one inside
the app.

## Cutting a release

1. Bump `__version__` in `version.py`.
2. Commit it.
3. Tag and push:

   ```bash
   git tag -a v1.1.0 -m "Short summary"
   git push origin main
   git push origin v1.1.0
   ```

4. The `Release` workflow builds all three installers in parallel (~20 minutes)
   and attaches them to a **draft** release.
5. Edit the notes on GitHub — the draft starts from
   `.github/release-notes-template.md` — and publish.

The workflow refuses to build if the tag and `version.py` disagree, so a
mismatched release cannot ship.

### Testing a packaging change without spending a version

Run the workflow manually (**Actions → Release → Run workflow**). It builds and
uploads the three installers as workflow artifacts and creates no release. Use
this for anything touching `packaging/`.

### Re-cutting a tag

Only for a release you have not published.

```bash
git tag -d v1.1.0
git push origin :refs/tags/v1.1.0
gh release delete v1.1.0 --yes    # if a draft was created
```

Then fix, re-tag and push again. Never move a tag people may already have
downloaded from — publish a new patch version instead.

## Building locally

```bash
bash packaging/macos/build_dmg.sh          # macOS, needs Xcode command line tools
pwsh packaging/windows/build_installer.ps1 # Windows, needs Inno Setup 6
bash packaging/linux/build_in_docker.sh    # Linux, needs Docker
```

Output lands in `dist/`. Both `build/` and `dist/` are gitignored.

To build just the payload without wrapping it in an installer:

```bash
python3 packaging/build_payload.py --dest build/payload
```

## Signing

Both the macOS and Windows builds are currently **unsigned**, which is a
deliberate cost decision, not an oversight. Users get one scary dialog on first
launch and the release notes tell them how to get past it.

The macOS bundle is still *ad-hoc* signed, because Apple Silicon refuses to
execute an unsigned Mach-O at all. That is unrelated to Gatekeeper.

### Turning on macOS signing later

Needs an Apple Developer account (£79/$99 a year).

1. Export the "Developer ID Application" certificate as a `.p12`.
2. Add repository secrets `MACOS_CERT_P12` (base64), `MACOS_CERT_PASSWORD`,
   `MACOS_SIGN_IDENTITY`, plus `AC_USERNAME`, `AC_PASSWORD` (an app-specific
   password) and `AC_TEAM_ID` for notarisation.
3. Add a step to the `macos` job that imports the certificate into a temporary
   keychain, and set `MACOS_SIGN_IDENTITY` in the build step's `env`.
   `build_dmg.sh` already reads it, switches to the hardened runtime and applies
   `packaging/macos/entitlements.plist`.
4. After the DMG is built, notarise and staple:

   ```bash
   xcrun notarytool submit dist/*.dmg --apple-id "$AC_USERNAME" \
     --password "$AC_PASSWORD" --team-id "$AC_TEAM_ID" --wait
   xcrun stapler staple dist/*.dmg
   ```

The entitlements are not optional. A bundled CPython cannot run under the
hardened runtime without library-validation disabled, because it loads extension
modules signed separately from the app.

### Turning on Windows signing later

SignPath and Azure Trusted Signing are both free for open-source projects, and
cheaper than a commercial Authenticode certificate. Sign
`dist/TaylorsTranscriber-<ver>-setup.exe` after Inno Setup produces it; nothing
in the build needs to change.

## Changing what is inside

### The bundled Python

`PYTHON_MINOR` in `packaging/build_payload.py`. **Bumping it is not free.** A
virtual environment is bound to the minor version that created it, so every
user's environment becomes unusable. `bootstrap.venv_is_usable` detects this and
rebuilds automatically, but the user still has to re-download whichever speech
runtimes they had installed — potentially several gigabytes.

Bump it only when there is a reason, and say so prominently in the release notes.

### ffmpeg

The app uses a very narrow slice of ffmpeg: decode a PNG sequence, encode
`prores_ks`, write a `.mov`. None of that touches a GPL component, so the builds
are LGPL and carry no licence obligation onto this app beyond redistributing
ffmpeg's own licence and source.

- **macOS** compiles it from source — `packaging/macos/build_ffmpeg.sh` — because
  no LGPL prebuild exists for macOS and the GPL ones would put their licence on
  everything shipped alongside. Configured down to only what the export needs,
  which also takes it from ~80 MB to 1.5 MB.
- **Windows and Linux** use [BtbN's](https://github.com/BtbN/FFmpeg-Builds) LGPL
  builds.

If the export command in `app.py` grows an option, the macOS build needs the
matching component enabled or the export will fail at run time rather than at
build time. The build script asserts that `prores_ks` and the `mov` muxer
survived; extend those checks alongside any new option.

### The app's own files

`APP_FILES` and `APP_DIRS` in `packaging/build_payload.py` are an explicit
allow-list, because an exclude list rots — a new data directory would silently
go missing from the installers. Add new files there.

## Reproducing an old build

The payload writes `MANIFEST.json` recording the exact interpreter URL. To
rebuild against the same components:

```bash
PBS_RELEASE=20250612 FFMPEG_URL=https://… bash packaging/macos/build_dmg.sh
```

## Linux

The AppImage is built inside `quay.io/pypa/manylinux_2_28_x86_64` rather than on
the GitHub runner. An AppImage runs against the *host's* glibc, so it can only
be built somewhere at least as old as the oldest target. Rocky Linux 9 is glibc
2.34 and Rocky 8 is 2.28, both older than Ubuntu 22.04's 2.35 — building on the
runner directly would produce something that refuses to start on exactly the
distributions this is for. The container is RHEL 8 based, which covers Rocky 8
and 9, RHEL, Fedora and Ubuntu 20.04 upwards.

The window comes from Qt, installed by pip complete with its own WebEngine,
because there is no system GTK/WebKit stack that can be relied on across
distributions. That is what makes the AppImage large. If Qt will not start — a
minimal host with no desktop libraries — `app.py` falls back to serving the
interface to the user's browser, so the AppImage degrades instead of dying.

### Why the AppImage installs itself

`AppRun` copies itself to `~/.local/share/taylors-transcriber/app` on first run
and launches from there, which is not what an AppImage normally does.

An AppImage is mounted at a fresh random path — `/tmp/.mount_XXXXXX` — on every
launch. A virtual environment records the absolute path of the interpreter that
created it, and this app's environment is where the user's speech runtimes live.
Run straight from the mount and that path dangles by the next launch:
`bootstrap.venv_is_usable` correctly sees a broken environment and rebuilds it,
throwing away several gigabytes of runtimes — on every single launch.

Copying once to a stable location fixes that and gives the app a desktop entry,
so it appears in the applications menu like anything else. The `.AppImage` file
can be deleted afterwards. `TT_NO_INSTALL=1` skips the install and runs from the
mount, which is useful for a quick look but rebuilds the environment each time.

The version in `usr/app/.bundled` is what decides whether to re-copy, so an
update is just running the new AppImage once. The copy goes to `app.new` and is
swapped into place, so an interrupted install cannot leave a half-written app.

## What users keep across an update

Installing over the top preserves everything expensive:

| | Where it lives | Survives an update |
| --- | --- | --- |
| Speech runtimes (torch, MLX…) | the app's environment in application support | yes |
| Downloaded models | `~/.cache/huggingface` | yes |
| The app itself | Applications / Program Files / anywhere | replaced |

This is why the environment is keyed by app identity rather than by install path
(`bootstrap.resolve_venv_dir`). Source checkouts still key by path, so several
clones never share one environment.
