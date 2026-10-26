#!/usr/bin/env bash
# Builds the linux/amd64 image and exports it as a gzip archive for delivery, with a
# SHA-256 checksum next to it. Load it elsewhere with:
#   docker load -i inventory-service-linux-amd64.tar.gz
#
#   scripts/export-image.sh                    # writes to ./artifacts
#   OUTPUT_DIR=/some/dir scripts/export-image.sh
set -euo pipefail

IMAGE="${IMAGE:-inventory-service:local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/artifacts}"
ARCHIVE="$OUTPUT_DIR/inventory-service-linux-amd64.tar.gz"

docker buildx build --platform linux/amd64 --load -t "$IMAGE" "$REPO_ROOT"

architecture="$(docker image inspect -f '{{.Architecture}}' "$IMAGE")"
if [[ "$architecture" != "amd64" ]]; then
  echo "Refusing to export: $IMAGE is $architecture, expected amd64" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
docker save "$IMAGE" | gzip -9 > "$ARCHIVE"
(cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")

echo "Image:    $IMAGE (linux/amd64, id $(docker image inspect -f '{{.Id}}' "$IMAGE"))"
echo "Archive:  $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "Checksum: $(cat "$ARCHIVE.sha256")"
echo
echo "To load and run:"
echo "  shasum -a 256 -c $(basename "$ARCHIVE").sha256"
echo "  docker load -i $(basename "$ARCHIVE")"
echo "  docker run --read-only --tmpfs /tmp --cap-drop ALL --memory 512m --cpus 1 -v inventory-data:/data -p 8080:8080 $IMAGE"
