## What changed

<!-- Replace this before publishing. -->

## Downloads

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `.dmg` | Open it and drag the app to Applications |
| Windows 10/11 (64-bit) | `-setup.exe` | Installs for you only — no administrator prompt |
| Linux (x86_64) | `.AppImage` | `chmod +x` it and run it once — it installs itself and adds a menu entry. Built for glibc 2.28, so Rocky 8/9, RHEL, Fedora and Ubuntu 20.04+ |

Nothing else is needed — Python and ffmpeg are inside the download.

## Updating from an earlier version

Install over the top. Your downloaded speech models and installed runtimes are
kept: they live outside the app, and the installers do not touch them.

## First launch on macOS

These builds are **not signed with an Apple Developer ID**, so macOS will say it
cannot verify the developer. Once:

1. Open the DMG and drag the app to Applications.
2. Launch it, and let the warning appear.
3. **System Settings → Privacy & Security**, scroll down, **Open Anyway**.

Or clear the quarantine flag yourself:

```
xattr -dr com.apple.quarantine "/Applications/Taylor's Transcriber.app"
```

## First launch on Windows

Unsigned too, so SmartScreen will show a blue "Windows protected your PC"
panel. Click **More info**, then **Run anyway**.

## Included components

ffmpeg is built from the official sources under the LGPL, configured for only
what the ProRes 4444 alpha export uses. See `packaging/` for the exact build.
