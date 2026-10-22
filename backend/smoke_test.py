"""smoke test for a built encore app: start it, analyse a short clip, check the result.

usage: python backend/smoke_test.py <Encore executable> [EncoreAI executable]
with the engine it also redoes the song in ai mode.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"


def get(path: str) -> dict:
    try:
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GET {path}: {e.code} {e.read()[:300]!r}") from e


def post(path: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(BASE + path, data=b"", method="POST"), timeout=30) as r:
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
    if len(sys.argv) > 2:
        env["ENCORE_ENGINE"] = str(Path(sys.argv[2]).resolve())
    log = tmp / "app.log"
    proc = subprocess.Popen([exe], env=env, stdout=log.open("w"), stderr=subprocess.STDOUT)
    try:
        return run(log, ai=len(sys.argv) > 2)
    except Exception as e:
        return report(f"{type(e).__name__}: {e}", log)
    finally:
        proc.kill()
        print(log.read_text(errors="replace"))


def wait(job_id: str, log: Path) -> dict | None:
    last = None
    for _ in range(1800):
        m = get(f"/api/jobs/{job_id}")
        if (m["status"], m.get("stage")) != last:
            last = (m["status"], m.get("stage"))
            print(*last, flush=True)
        if m["status"] in ("done", "error"):
            break
        time.sleep(1)
    if m["status"] != "done" or m.get("reanalyze_error"):
        report(f"analysis failed at '{m.get('stage')}': {m.get('error') or m.get('reanalyze_error')}", log)
        return None
    return get(f"/api/jobs/{job_id}/analysis")


def run(log: Path, ai: bool) -> int:
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
    a = wait(job["id"], log)
    if a is None:
        return 1
    print("classic:", a["key"], a["bpm"], "bpm,", len(a["notes"]), "bass notes,", sorted(a["audio"]))
    assert a["result_mode"] == "classic" and set(a["audio"]) == {"drums", "bass", "vocals", "other"}, a["audio"]
    with urllib.request.urlopen(f"{BASE}/api/jobs/{job['id']}/files/bass.mp3", timeout=10) as r:
        assert len(r.read()) > 10000
    if ai:
        post(f"/api/jobs/{job['id']}/reanalyze?mode=ai")
        a = wait(job["id"], log)
        if a is None:
            return 1
        print("ai:", a["key"], a["bpm"], "bpm,", len(a["notes"]), "bass notes,", sorted(a["audio"]))
        assert a["result_mode"] == "ai" and {"guitar", "piano"} <= set(a["audio"]), a["audio"]
    return 0


if __name__ == "__main__":
    sys.exit(main())
