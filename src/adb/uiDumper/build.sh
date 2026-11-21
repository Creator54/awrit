#!/bin/sh
# Rebuilds the base64 jar embedded in ../uiDump.ts from Dumper.java.
# Needs javac, d8 and an android.jar: ANDROID_JAR=.../android.jar D8=.../d8 sh build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
javac -source 8 -target 8 -cp "$ANDROID_JAR" -d "$tmp/classes" "$here/Dumper.java"
(cd "$tmp/classes" && jar cf ../d.jar .)
"$D8" --min-api 26 --lib "$ANDROID_JAR" --output "$tmp" "$tmp/d.jar"
python3 - "$tmp/classes.dex" <<'PY'
import base64, io, sys, zipfile
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    info = zipfile.ZipInfo('classes.dex', (2008, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, open(sys.argv[1], 'rb').read())
print(base64.b64encode(buf.getvalue()).decode())
PY
