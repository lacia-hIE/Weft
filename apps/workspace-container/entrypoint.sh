#!/bin/sh
set -eu
node /opt/weft/processd.mjs &
processd=$!
/usr/local/bin/computerd &
computer=$!
stop() {
  kill -TERM "$processd" "$computer" 2>/dev/null || true
  wait "$processd" "$computer" 2>/dev/null || true
}
trap stop TERM INT EXIT
# Either daemon exiting invalidates the runtime; never leave a half-working container.
while kill -0 "$processd" 2>/dev/null && kill -0 "$computer" 2>/dev/null; do sleep 1; done
exit 1
