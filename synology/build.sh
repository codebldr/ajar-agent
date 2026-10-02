#!/bin/sh
# Builds the Synology package: one .spk for every model, since the agent is plain JavaScript and
# Node comes from Synology's own Node.js package.
#
#   synology/build.sh 1.0.0-0001      → dist/ajar-1.0.0-0001-noarch.spk
#
# Needs GNU tar and md5sum — the CI runner has both; on a Mac, run it in a Linux container.
#
# An .spk is a tar holding INFO, package.tgz (what lands in /var/packages/ajar/target) and the
# package's scripts, configuration, wizard and icons. That is all Synology's toolkit produces for
# a noarch package, so this builds it directly rather than through the toolkit's chroot.
set -eu

VERSION="${1:-1.0.0-0001}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/synology"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARGET="$WORK/target"
PKG="$WORK/pkg"
mkdir -p "$TARGET/app" "$PKG" "$ROOT/dist"

# What runs on the NAS: the agent, exactly as the container and the Pi run it, and the two
# helpers that start it there.
cp "$ROOT"/*.mjs "$TARGET/"
cp "$HERE/app/ajar-start" "$HERE/app/configure.mjs" "$HERE/app/ajar.sc" "$TARGET/app/"
chmod 755 "$TARGET/app/ajar-start"

tar --owner=0 --group=0 -czf "$PKG/package.tgz" -C "$TARGET" .

cp -R "$HERE/scripts" "$HERE/conf" "$HERE/WIZARD_UIFILES" "$PKG/"
chmod 755 "$PKG"/scripts/*
cp "$HERE/PACKAGE_ICON.PNG" "$HERE/PACKAGE_ICON_256.PNG" "$PKG/"

sed "s/@VERSION@/$VERSION/" "$HERE/INFO.in" > "$PKG/INFO"
echo "checksum=\"$(md5sum "$PKG/package.tgz" | cut -d' ' -f1)\"" >> "$PKG/INFO"

OUT="$ROOT/dist/ajar-$VERSION-noarch.spk"
tar --owner=0 --group=0 -cf "$OUT" -C "$PKG" \
  INFO package.tgz scripts conf WIZARD_UIFILES PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG

echo "$OUT"
