#!/usr/bin/env bash
set -euo pipefail

# Check the exact app shipped in both distribution formats without modifying it.
bundle=$(cd "${1:-src-tauri/target/release/bundle}" && pwd)
verify_app() {
  codesign --verify --deep --strict --verbose=2 \
    -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$1"
  xcrun stapler validate "$1"
  spctl --assess --type execute --verbose=4 "$1"
}

verify_app "$bundle/macos/Mossentry.app"

archives=("$bundle"/macos/*.app.tar.gz)
installers=("$bundle"/dmg/*.dmg)
if [[ ${#archives[@]} -ne 1 || ! -f "${archives[0]}" || ${#installers[@]} -ne 1 || ! -f "${installers[0]}" ]]; then
  echo 'Expected exactly one macOS updater archive and one DMG.' >&2
  exit 1
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/mossentry-verification.XXXXXX")
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    if ! hdiutil detach "$temporary/dmg" -quiet; then
      echo "Could not unmount $temporary/dmg; leaving verification files in place." >&2
      return 1
    fi
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT

mkdir "$temporary/updater" "$temporary/dmg"
tar -xzf "${archives[0]}" -C "$temporary/updater"
verify_app "$temporary/updater/Mossentry.app"

hdiutil attach -readonly -nobrowse -quiet -mountpoint "$temporary/dmg" "${installers[0]}"
mounted=true
verify_app "$temporary/dmg/Mossentry.app"
