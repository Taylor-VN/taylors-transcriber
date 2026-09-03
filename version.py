"""
Single source of truth for the release version.

The packaging scripts and the release workflow read this file, and the tag they
build from must match it — a mismatch fails the build rather than shipping a DMG
whose About box lies. Bump it in the same commit that you tag.
"""

__version__ = '1.0.0'

# Bundled builds (DMG / setup.exe / AppImage) stamp this file's directory with a
# marker; see bootstrap.is_bundled(). Running from a source checkout leaves it
# unset, which is how the app tells "installed" from "developing".
APP_NAME = "Taylor's Transcriber"
APP_ID = 'com.taylorvn.transcriber'
