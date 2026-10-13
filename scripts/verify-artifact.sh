#!/usr/bin/env bash
set -euo pipefail
input=${1:?usage: verify-artifact.sh FILE SIGNATURE}
signature=${2:?usage: verify-artifact.sh FILE SIGNATURE}
[[ -n ${XRIG_ED25519_PUBLIC_KEY_B64:-} ]] || { echo 'XRIG_ED25519_PUBLIC_KEY_B64 is required' >&2; exit 2; }
key=$(mktemp); trap 'rm -f "$key"' EXIT
printf %s "$XRIG_ED25519_PUBLIC_KEY_B64" | base64 -d > "$key"
openssl pkeyutl -verify -rawin -pubin -inkey "$key" -in "$input" -sigfile "$signature"
