"""smoke test for a built encore app: start it, analyse a short clip, check the result.

usage: python backend/smoke_test.py <path to the Encore executable>
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.load(r)


def upload(path: Path) -> dict:
    # multipart form by hand, so the test needs nothing beyond the app's own deps
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nfile\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: audio/wav\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/api/jobs", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def clip(path: Path) -> None:
    """12 s of a bass line, a chord pad and a kick: enough for every stage to run."""
    sr = 44100
    t = np.arange(12 * sr) / sr
    bass = 0.4 * np.sin(2 * np.pi * np.where((t % 2) < 1, 55.0, 73.4) * t)
    pad = 0.15 * sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.2, 329.6))
    kick = 0.8 * np.exp(-30 * (t % 0.5)) * np.sin(2 * np.pi * 50 * t)
    y = bass + pad + kick
    sf.write(path, np.stack([y, y], 1) / np.abs(y).max() * 0.8, sr)


def report(msg: str, log: Path) -> int:
    """github annotation with the app's last log lines (job logs need a login, annotations don't)."""
    tail = log.read_text(errors="replace").splitlines()[-40:] if log.exists() else []
    text = "\n".join([msg, *tail]).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::error title=smoke test::{text}")
    return 1


def main() -> int:
    exe = sys.argv[1]
    tmp = Path(tempfile.mkdtemp())
    env = {**os.environ, "PORT": str(PORT), "ENCORE_DATA": str(tmp / "data"), "BROWSER": "true"}
    log = tmp / "app.log"
    proc = subprocess.Popen([exe], env=env, stdout=log.open("w"), stderr=subprocess.STDOUT)
    try:
        return run(log)
    except Exception as e:
        return report(f"{type(e).__name__}: {e}", log)
    finally:
        proc.kill()
        print(log.read_text(errors="replace"))


def run(log: Path) -> int:
    tmp = log.parent
    for _ in range(180):
        try:
            print("health:", get("/api/health"))
            break
        except Exception:
            time.sleep(1)
    else:
        return report("app did not start", log)
    clip(tmp / "smoke.wav")
    job = upload(tmp / "smoke.wav")
    last = None
    for _ in range(1800):
        m = get(f"/api/jobs/{job['id']}")
        if (m["status"], m.get("stage")) != last:
            last = (m["status"], m.get("stage"))
            print(*last)
        if m["status"] in ("done", "error"):
            break
        time.sleep(1)
    if m["status"] != "done":
        return report(f"analysis failed at '{m.get('stage')}': {m.get('error')}", log)
    a = get(f"/api/jobs/{job['id']}/analysis")
    print("result:", a["key"], a["bpm"], "bpm,", len(a["notes"]), "bass notes,", sorted(a["audio"]))
    assert set(a["audio"]) >= {"drums", "bass", "vocals", "other"}, a["audio"]
    with urllib.request.urlopen(f"{BASE}/api/jobs/{job['id']}/files/bass.mp3", timeout=10) as r:
        assert len(r.read()) > 10000
    return 0


if __name__ == "__main__":
    sys.exit(main())
