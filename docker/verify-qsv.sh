#!/bin/sh
# Prove that FFmpeg can initialize Intel oneVPL and produce a real H.264 QSV bitstream.
set -eu

if [ "$#" -gt 1 ]; then
  echo "Usage: verify-qsv [render-device]" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  DEVICE=$1
else
  if [ ! -d /dev/dri ]; then
    echo "QSV check failed: /dev/dri is missing (pass /dev/dri into the container)" >&2
    exit 1
  fi
  DEVICE=
  for candidate in /dev/dri/renderD*; do
    if [ -e "$candidate" ]; then
      DEVICE=$candidate
      break
    fi
  done
  if [ -z "$DEVICE" ]; then
    echo "QSV check failed: no render node found under /dev/dri" >&2
    exit 1
  fi
fi

if [ ! -e "$DEVICE" ]; then
  echo "QSV check failed: no device at $DEVICE" >&2
  exit 1
fi

tmpdir=$(mktemp -d)
output=$tmpdir/qsv-check.mkv
trap 'rm -rf "$tmpdir"' EXIT

ffmpeg -hide_banner -loglevel error -nostdin \
  -init_hw_device "qsv:hw,child_device=$DEVICE" -filter_hw_device hw \
  -f lavfi -i 'testsrc2=size=640x360:rate=24' -frames:v 48 \
  -vf 'format=nv12,hwupload' -c:v h264_qsv -y "$output"
codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$output")
[ "$codec" = h264 ] || { echo "QSV check failed: output codec was $codec" >&2; exit 1; }
echo "QSV OK: encoded 48 H.264 frames on $DEVICE (h264_qsv)"
