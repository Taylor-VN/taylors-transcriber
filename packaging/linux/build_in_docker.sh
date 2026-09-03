#!/usr/bin/env bash
#
# Run the AppImage build inside the manylinux_2_28 container, which is what
# makes the result run on Rocky Linux. Use this locally; the release workflow
# invokes the same container directly.
#
#   packaging/linux/build_in_docker.sh
#
# Output lands in dist/ on the host, owned by you rather than by root.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${MANYLINUX_IMAGE:-quay.io/pypa/manylinux_2_28_x86_64}"

docker run --rm \
  -v "$ROOT:/src" \
  -w /src \
  -e HOST_PYTHON=/opt/python/cp312-cp312/bin/python3 \
  -e "PBS_RELEASE=${PBS_RELEASE:-}" \
  -e HOME=/tmp \
  -u "$(id -u):$(id -g)" \
  "$IMAGE" \
  bash packaging/linux/build_appimage.sh /src/dist
