#!/bin/sh
# Generates the DEVELOPMENT RSA key pair used to sign Access Tokens (DT-01) in user/.keys (ignored by git).
# Every replica must use the same private key, so it is generated once and mounted, never per instance.
# Production keys come from the team's secret management, not from this script.
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/.keys"
file="$dir/jwt-private.pem"
if [ -e "$file" ]; then
  echo "Key already exists: $file (delete it to rotate; existing tokens stop being valid)"
  exit 0
fi
mkdir -p "$dir"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$file"
# Readable by the non-root container user (uid 10001) through the bind mount. Development key only.
chmod 644 "$file"
echo "Generated $file"
