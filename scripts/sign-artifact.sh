#!/usr/bin/env bash
set -euo pipefail
input=${1:?usage: sign-artifact.sh FILE [SIGNATURE]}
output=${2:-"$input.sig"}
[[ -n ${XRIG_ED25519_PRIVATE_KEY_B64:-} ]] || { echo 'XRIG_ED25519_PRIVATE_KEY_B64 is required (protected environment only)' >&2; exit 2; }
key=$(mktemp); trap 'rm -f "$key"' EXIT
printf %s "$XRIG_ED25519_PRIVATE_KEY_B64" | base64 -d > "$key"; chmod 600 "$key"
openssl pkeyutl -sign -rawin -inkey "$key" -in "$input" -out "$output"
[[ "$(stat -c %s "$output")" == 64 ]] || { echo 'expected an Ed25519 detached signature' >&2; exit 1; }
