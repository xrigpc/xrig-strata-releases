#!/usr/bin/env bash
# Throwaway staging identity for a test rig. NEVER uses or needs production keys.
# Creates (once) under STAGING_HOME (default ~/.xrig-staging):
#   signing key (Ed25519, PKCS8 DER base64) + its raw public key hex
#   a local CA and a 127.0.0.1 server certificate, plus a CA bundle that also
#   trusts the system roots (Hugging Face and AMD downloads keep working)
# Then prints the environment a vertexstaging build and build-tree.sh need.
set -euo pipefail
home=${STAGING_HOME:-$HOME/.xrig-staging}
port=${STAGING_PORT:-8443}
mkdir -p "$home" && chmod 700 "$home"
if [[ ! -f "$home/signing.key.b64" ]]; then
  openssl genpkey -algorithm ed25519 -outform DER -out "$home/signing.der"
  base64 -w0 "$home/signing.der" > "$home/signing.key.b64"
  openssl pkey -inform DER -in "$home/signing.der" -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \n' > "$home/signing.pub.hex"
  openssl pkey -inform DER -in "$home/signing.der" -pubout -outform DER | base64 -w0 > "$home/signing.pub.b64"
  rm -f "$home/signing.der"
fi
if [[ ! -f "$home/server.crt" ]]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj '/CN=XRIG staging CA (test only)' \
    -keyout "$home/ca.key" -out "$home/ca.crt" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj '/CN=127.0.0.1' -keyout "$home/server.key" -out "$home/server.csr" 2>/dev/null
  printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$home/server.ext"
  openssl x509 -req -in "$home/server.csr" -CA "$home/ca.crt" -CAkey "$home/ca.key" -CAcreateserial -days 30 -extfile "$home/server.ext" -out "$home/server.crt" 2>/dev/null
  cat /etc/ssl/certs/ca-certificates.crt "$home/ca.crt" > "$home/ca-bundle.crt"
fi
cat <<ENV
export XRIG_STAGING_BASE_URL=https://127.0.0.1:$port
export XRIG_STAGING_PUBKEY_HEX=$(cat "$home/signing.pub.hex")
export XRIG_ED25519_PRIVATE_KEY_B64=$(cat "$home/signing.key.b64")
export XRIG_ED25519_PUBLIC_KEY_B64=$(cat "$home/signing.pub.b64")
export SSL_CERT_FILE=$home/ca-bundle.crt
export STAGING_HOME=$home STAGING_PORT=$port
ENV
