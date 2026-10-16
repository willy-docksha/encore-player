"""push songs analysed on this mac to a view-only encore server.

usage (via ./publish.sh):
  publish.sh                 publish every finished song that is new or changed
  publish.sh <id|title> ...  publish only these songs
  publish.sh --list          show which songs are on the server
  publish.sh --remove <id>   remove a song from the server
needs ENCORE_SERVER (e.g. https://encore.example.com) and ENCORE_PUBLISH_TOKEN.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "jobs"
SEND = ("meta.json", "analysis.json",
        *(f"{n}.mp3" for n in ("bass", "rest", "drums", "vocals", "guitar", "piano", "other")),
        *(f"{n}.mid" for n in ("bass", "vocals", "piano", "guitar", "drums")))


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def local_songs() -> list[dict]:
    out = []
    for p in DATA.glob("*/meta.json"):
        m = json.loads(p.read_text())
        if m.get("status") == "done" and (p.parent / "analysis.json").exists():
            out.append(m)
    return sorted(out, key=lambda m: m.get("created", 0))


def remote_songs(base: str) -> dict[str, dict]:
    r = requests.get(f"{base}/api/jobs", timeout=30)
    r.raise_for_status()
    return {j["id"]: j for j in r.json()}


def pick(songs: list[dict], wanted: list[str]) -> list[dict]:
    out = []
    for w in wanted:
        hit = [m for m in songs if m["id"] == w] or [m for m in songs if w.lower() in (m.get("title") or "").lower()]
        if not hit:
            die(f"lagu tidak ditemukan: {w}")
        if len(hit) > 1:
            die(f"'{w}' cocok dengan {len(hit)} lagu, pakai id-nya:\n" + "\n".join(f"  {m['id']}  {m['title']}" for m in hit))
        out.append(hit[0])
    return out


def publish(base: str, auth: dict, m: dict) -> None:
    folder = DATA / m["id"]
    names = [n for n in SEND if (folder / n).exists()]
    size = sum((folder / n).stat().st_size for n in names) / 1e6
    print(f"↑ {m['title']}  ({size:.1f} MB)", flush=True)
    handles = [(n, (folder / n).open("rb")) for n in names]
    try:
        r = requests.post(f"{base}/api/publish/{m['id']}", headers=auth,
                          files=[("files", (n, f)) for n, f in handles], timeout=600)
    finally:
        for _, f in handles:
            f.close()
    if not r.ok:
        die(f"  gagal ({r.status_code}): {r.json().get('detail', r.text) if 'json' in r.headers.get('content-type', '') else r.text}")


def main(args: list[str]) -> None:
    base = os.environ.get("ENCORE_SERVER", "").strip().rstrip("/")
    token = os.environ.get("ENCORE_PUBLISH_TOKEN", "").strip()
    if not base or not token:
        die("isi ENCORE_SERVER dan ENCORE_PUBLISH_TOKEN dulu (lihat publish.env.example)")
    auth = {"Authorization": f"Bearer {token}"}
    songs = local_songs()
    remote = remote_songs(base)

    if args[:1] == ["--list"]:
        for m in songs:
            r = remote.get(m["id"])
            state = "belum" if not r else "sudah" if r.get("finished") == m.get("finished") else "perlu update"
            print(f"{m['id']}  {state:<12}  {m['title']}")
        for i in remote.keys() - {m["id"] for m in songs}:
            print(f"{i}  {'hanya server':<12}  {remote[i].get('title')}")
        return

    if args[:1] == ["--remove"]:
        if not args[1:]:
            die("sebutkan id lagu yang mau dihapus dari server")
        for i in args[1:]:
            r = requests.delete(f"{base}/api/jobs/{i}", headers=auth, timeout=30)
            print(f"{'✓' if r.ok else '✗'} {i}" + ("" if r.ok else f"  ({r.status_code} {r.text})"))
        return

    stale = lambda m: m["id"] not in remote or remote[m["id"]].get("finished") != m.get("finished")
    todo = pick(songs, args) if args else [m for m in songs if stale(m)]
    if not todo:
        print("semua lagu sudah ter-publish")
        return
    for m in todo:
        publish(base, auth, m)
    print(f"selesai: {len(todo)} lagu di {base}")


if __name__ == "__main__":
    main(sys.argv[1:])
