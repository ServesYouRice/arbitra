#!/bin/sh
# Finishes the macOS app on a Mac: `sh tooling/package/make-dmg.sh dist-package/darwin-arm64 [version]`.
# It restores the execute bits a build on Windows cannot set, signs the app ad hoc (no Apple developer account: the
# first open needs System Settings > Privacy & Security > Open Anyway), and packs it into arbitra-<version>-<arch>.dmg.
set -e
dir="$1"; version="${2:-dev}"
[ -d "$dir/arbitra.app" ] || { echo "no arbitra.app in $dir"; exit 1; }
arch="$(basename "$dir" | sed 's/^darwin-//')"
chmod +x "$dir/arbitra.app/Contents/MacOS/arbitra-launcher" "$dir/arbitra.app/Contents/Resources/arbitra"
xattr -cr "$dir/arbitra.app"
codesign --remove-signature "$dir/arbitra.app/Contents/Resources/arbitra" 2>/dev/null || true
codesign --force --sign - "$dir/arbitra.app/Contents/Resources/arbitra"
codesign --force --sign - "$dir/arbitra.app"
staging="$(mktemp -d)"
cp -R "$dir/arbitra.app" "$staging/"
ln -s /Applications "$staging/Applications"
hdiutil create -volname arbitra -srcfolder "$staging" -ov -format UDZO "$dir/arbitra-$version-$arch.dmg"
rm -rf "$staging"
echo "made $dir/arbitra-$version-$arch.dmg"
