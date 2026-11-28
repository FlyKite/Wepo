#!/usr/bin/env python3
"""wxgf (WeChat HEVC image) -> JPEG converter worker.

The converter locates the HEVC Annex-B start code inside the wxgf container,
decodes the embedded video frame with PyAV, then saves it as JPEG.

Reads one JSON request per line from stdin and writes one JSON response per
line to stdout. The worker is kept alive so PyAV is imported only once.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import traceback

import av
from PIL import Image


def convert_wxgf_to_jpeg(source: str, destination: str) -> dict:
    with open(source, "rb") as file:
        data = file.read()

    hevc_start = data.find(b"\x00\x00\x00\x01\x40\x01")
    if hevc_start < 0:
        hevc_start = data.find(b"\x00\x00\x00\x01\x42\x01")
    if hevc_start < 0:
        raise ValueError("未找到 HEVC 起始码")

    fd, temp_hevc = tempfile.mkstemp(suffix=".h265")
    os.close(fd)
    try:
        with open(temp_hevc, "wb") as file:
            file.write(data[hevc_start:])

        container = av.open(temp_hevc, format="hevc")
        try:
            last_frame = None
            for frame in container.decode(video=0):
                last_frame = frame
            if last_frame is None:
                raise ValueError("未解码出图像帧")
            image = last_frame.to_image()
            output = io.BytesIO()
            image.save(output, "JPEG", quality=90)
            jpeg = output.getvalue()
        finally:
            container.close()
    finally:
        try:
            os.unlink(temp_hevc)
        except OSError:
            pass

    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temp_jpeg = f"{destination}.tmp-{os.getpid()}"
    try:
        with open(temp_jpeg, "wb") as file:
            file.write(jpeg)
        os.replace(temp_jpeg, destination)
    finally:
        try:
            if os.path.exists(temp_jpeg):
                os.unlink(temp_jpeg)
        except OSError:
            pass

    return {
        "width": image.width,
        "height": image.height,
        "bytes": len(jpeg),
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = convert_wxgf_to_jpeg(request["src"], request["dst"])
            print(json.dumps({"id": request_id, "ok": True, **result}), flush=True)
        except Exception as error:  # noqa: BLE001 - report any conversion failure
            print(
                json.dumps({
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                }),
                flush=True,
            )
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
