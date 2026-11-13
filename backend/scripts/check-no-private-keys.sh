#!/usr/bin/env bash
# Keep-out gate for fr#1266: fails if ANY tracked file in the tree is a private
# key, by content or by name.
#
# Why a TREE scan and not gitleaks: the org secret-scan action is a RANGE scan
# (it judges only lines an event adds), so the ten key/cert files that sat on
# main were never seen by it. This walks `git ls-files`, so a key that is
# already on main keeps the check red until it is removed.
#
# Why not a repo-local .gitleaks.toml: the composite action uses a repo's
# .gitleaks.toml INSTEAD of the fleet config, which would drop every fleet rule.
#
# Prints file paths only, never file contents.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

content_re='-----BEGIN (RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY-----'
# Private-key file names: *.key, *-key.pem, *_key.pem, *.key.pem, privkey*.pem,
# PKCS#12 bundles. Plain *.pem is NOT matched by name (a public cert is fine);
# a .pem holding a key is caught by the content rule.
name_re='(\.key|[-_.]key\.pem|(^|/)privkey[^/]*\.pem|\.p12|\.pfx)$'

# git grep searches exactly the tracked files and has ONE exit code:
# 0 = match, 1 = no match, anything else = the scan itself failed. Fail closed
# on the last case, so a broken scan can never read as "0 keys".
set +e
by_content=$(git grep -lIE -e "$content_re")
rc=$?
set -e
if [ "$rc" -gt 1 ]; then
  echo "::error::private-key content scan failed (git grep exit $rc)"
  exit 2
fi
if ! tracked=$(git ls-files); then
  echo "::error::git ls-files failed; cannot prove no private-key files are tracked"
  exit 2
fi
set +e
by_name=$(printf '%s\n' "$tracked" | grep -iE -- "$name_re")
rc=$?
set -e
if [ "$rc" -gt 1 ]; then
  echo "::error::private-key file-name scan failed (grep exit $rc)"
  exit 2
fi

hits=$(printf '%s\n%s\n' "$by_content" "$by_name" | sed '/^$/d' | sort -u)

if [ -n "$hits" ]; then
  echo "Private key material is tracked in this repo (fr#1266 keep-out):"
  while IFS= read -r f; do
    echo "::error file=${f}::tracked private key (PEM private-key header or private-key file name)"
    echo "  $f"
  done <<<"$hits"
  echo "Remove the file(s) with 'git rm'; keys belong in SOPS/Secrets, never the tree."
  exit 1
fi

n=$(git ls-files | wc -l | tr -d ' ')
echo "OK: 0 private keys across ${n} tracked files."
