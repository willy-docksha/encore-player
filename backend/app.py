"""encore local server: the web app, drive/title helpers, and the bass analysis queue.

the same frontend also deploys to vercel without this server; there the bass
section reports that it needs the mac (see /api/health).

job flow: queued -> downloading -> waiting -> running -> done
downloads run in parallel; the heavy analysis runs one song at a time.
"""

from __future__ import annotations

import hmac
import html
import http.cookiejar
import json
import os
import re
import shutil
import statistics
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from pipeline import (DRUM_VERSION, PIPELINE_VERSION, YOUTUBE_OFF_MSG, analyze, cached_download, drum_hits, fetch_audio,
                      safe_name, shutdown_pool, source_key, stem_layers, write_drum_midi)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "jobs"
DATA.mkdir(parents=True, exist_ok=True)
CACHE = ROOT / "data" / "cache"  # original downloads, keyed by video / file id
# local (default, run.sh): youtube links allowed. server: only uploads and google drive links,
# so a shared deployment never downloads from youtube. results analysed locally still open fine.
MODE = os.environ.get("ENCORE_MODE", "local").strip().lower()
ALLOW_YOUTUBE = MODE != "server"
# ENCORE_ANALYSIS=off: view-only server (too small for demucs). songs are analysed on the mac
# and pushed here with publish.sh, authorised by ENCORE_PUBLISH_TOKEN.
ALLOW_ANALYSIS = os.environ.get("ENCORE_ANALYSIS", "on").strip().lower() not in ("off", "0", "no", "false")
PUBLISH_TOKEN = os.environ.get("ENCORE_PUBLISH_TOKEN", "").strip()
NO_ANALYSIS_MSG = "Server ini hanya menampilkan hasil. Analisis lagu di Encore versi Mac, lalu publish ke sini."
INCOMING = ROOT / "data" / "incoming"  # publish staging, outside DATA so half uploads never list
# files a finished job may serve (older jobs have bass + rest, newer ones all stems)
PUBLIC_JOB_FILES = ({f"{n}.mp3" for n in ("bass", "rest", "drums", "vocals", "guitar", "piano", "other")}
                    | {f"{n}.mid" for n in ("bass", "vocals", "piano", "guitar", "drums")})
# only these root files are public; never serve the repo folder itself
PUBLIC_FILES = ("index.html", "sw.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png")
# files publish.sh may push for a job
PUBLISH_FILES = PUBLIC_JOB_FILES | {"meta.json", "analysis.json"}


@asynccontextmanager
async def lifespan(_app):
    yield
    # stop pyin worker processes so they don't outlive the server
    shutdown_pool()


app = FastAPI(title="Encore", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    # always revalidate html/js/css so updates show up without a hard refresh
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


download_pool = ThreadPoolExecutor(max_workers=2)
analysis_pool = ThreadPoolExecutor(max_workers=1)  # demucs is heavy, one song at a time
lock = threading.Lock()
cancelled: set[str] = set()

ACTIVE = ("queued", "downloading", "waiting", "running")


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- meta helpers

def meta_path(job_id: str) -> Path:
    return DATA / job_id / "meta.json"


def read_meta(job_id: str) -> dict:
    p = meta_path(job_id)
    if not p.exists():
        raise HTTPException(404, "job tidak ditemukan")
    return json.loads(p.read_text())


def write_meta(job_id: str, **updates) -> dict | None:
    with lock:
        p = meta_path(job_id)
        if not p.parent.exists():
            return None  # deleted meanwhile
        meta = json.loads(p.read_text()) if p.exists() else {}
        meta.update(updates)
        p.write_text(json.dumps(meta))
        return meta


def all_meta() -> list[dict]:
    out = []
    for p in DATA.glob("*/meta.json"):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            pass
    return out


def upload_path(job_id: str, source: dict) -> Path:
    """uploads live in the job folder; older jobs stored an absolute path."""
    return DATA / job_id / Path(source["path"]).name


def resolved_source(job_id: str, source: dict) -> dict:
    if source.get("type") == "file":
        return {**source, "path": str(upload_path(job_id, source))}
    return source


def check_cancel(job_id: str) -> None:
    if job_id in cancelled or not (DATA / job_id).exists():
        raise Cancelled()


# ---------------------------------------------------------------- workers

def download_stage(job_id: str) -> None:
    try:
        check_cancel(job_id)
        meta = read_meta(job_id)
        write_meta(job_id, status="downloading", stage="Mengunduh audio", progress=0.0, error=None)
        info = fetch_audio(
            DATA / job_id, resolved_source(job_id, meta["source"]),
            lambda p: write_meta(job_id, progress=round(p, 3)),
            cache_dir=CACHE,
            allow_youtube=ALLOW_YOUTUBE,
        )
        check_cancel(job_id)
        write_meta(job_id, status="waiting", stage="Menunggu giliran diproses", progress=0.0,
                   title=info["title"], duration=info["duration"], downloaded=time.time(),
                   from_cache=info["from_cache"])
        analysis_pool.submit(analysis_stage, job_id)
    except Cancelled:
        finish_cancel(job_id)
    except Exception as e:
        traceback.print_exc()
        fail(job_id, "Gagal mengunduh", e, "download")


def analysis_stage(job_id: str) -> None:
    try:
        check_cancel(job_id)
        meta = read_meta(job_id)
        started = time.time()
        write_meta(job_id, status="running", stage="Memulai", progress=0.0, started=started, error=None)

        def progress(stage: str, pct: float) -> None:
            check_cancel(job_id)
            write_meta(job_id, stage=stage, progress=round(pct, 3))

        result = analyze(DATA / job_id, meta.get("title") or "audio", progress)
        write_meta(job_id, status="done", stage="Selesai", progress=1.0, title=result["title"],
                   duration=result["duration"], key=result["key"], bpm=result["bpm"],
                   compute_sec=round(time.time() - started, 1), finished=time.time(),
                   reanalyze_error=None,
                   version=result.get("version"))
    except Cancelled:
        finish_cancel(job_id)
    except Exception as e:
        traceback.print_exc()
        fail(job_id, "Gagal diproses", e, "analysis")


def finish_cancel(job_id: str) -> None:
    cancelled.discard(job_id)
    shutil.rmtree(DATA / job_id, ignore_errors=True)


def fail(job_id: str, stage: str, err: Exception, failed: str) -> None:
    """mark a failure; a song that already has results stays usable in the library."""
    if (DATA / job_id / "analysis.json").exists():
        write_meta(job_id, status="done", stage="Selesai", progress=1.0,
                   reanalyze_error=f"{stage}: {err}", reanalyze_failed_at=time.time())
    else:
        write_meta(job_id, status="error", stage=stage, error=str(err), failed=failed)


def enqueue(job_id: str, meta: dict) -> None:
    src_ready = (DATA / job_id / "tmp" / "source.wav").exists()
    if src_ready and meta.get("title"):
        write_meta(job_id, status="waiting", stage="Menunggu giliran diproses", progress=0.0, error=None)
        analysis_pool.submit(analysis_stage, job_id)
    else:
        write_meta(job_id, status="queued", stage="Menunggu unduhan", progress=0.0, error=None)
        download_pool.submit(download_stage, job_id)


# ---------------------------------------------------------------- queue info

def seconds_per_audio_second(jobs: list[dict]) -> float:
    ratios = [j["compute_sec"] / j["duration"] for j in jobs
              if j.get("status") == "done" and j.get("compute_sec") and j.get("duration")]
    return statistics.median(ratios[-10:]) if ratios else 0.6


def with_queue_info(jobs: list[dict]) -> list[dict]:
    """adds position (1 = next in line) and eta_sec for active jobs."""
    rate = seconds_per_audio_second(jobs)
    fallback = 240.0  # unknown duration (still downloading)
    running = [j for j in jobs if j.get("status") == "running"]
    # analysis order: downloaded jobs first (in the order they finished downloading), then the rest
    line = sorted((j for j in jobs if j.get("status") in ("queued", "downloading", "waiting")),
                  key=lambda j: (j["status"] != "waiting", j.get("downloaded") or j.get("created", 0)))
    ahead = 0.0
    for j in running:
        total = rate * j["duration"] if j.get("duration") else fallback
        elapsed = time.time() - j.get("started", time.time())
        p = j.get("progress") or 0.0
        # once under way, trust the job's own speed more than history
        remaining = elapsed * (1 - p) / p if p >= 0.15 else total - elapsed
        j["eta_sec"] = round(max(5.0, remaining))
        ahead += j["eta_sec"]
    for pos, j in enumerate(line, 1):
        own = rate * j["duration"] if j.get("duration") else fallback
        j["position"] = pos
        j["eta_sec"] = round(ahead + own)
        ahead += own
    return jobs


# ---------------------------------------------------------------- api

def new_job_id() -> str:
    job_id = uuid.uuid4().hex[:10]
    (DATA / job_id).mkdir()
    return job_id


def existing_job(source: dict) -> dict | None:
    """a job for the same video / drive file that is done or still in the queue."""
    key = source_key(source)
    if not key:
        return None
    for m in all_meta():
        src = m.get("source") or {}
        if src.get("type") == source["type"] and source_key(src) == key and m.get("status") != "error":
            return m
    return None


@app.post("/api/jobs")
async def create_job(
    kind: str = Form(...),
    url: str | None = Form(None),
    file: UploadFile | None = File(None),
):
    if not ALLOW_ANALYSIS:
        raise HTTPException(403, NO_ANALYSIS_MSG)
    if kind in ("youtube", "gdrive"):
        if not url or not url.strip().startswith("http"):
            raise HTTPException(400, "link tidak valid")
        source = {"type": kind, "url": url.strip()}
        same = existing_job(source)
        if same:
            return {**public(same), "existing": True}
        if kind == "youtube" and not ALLOW_YOUTUBE:
            raise HTTPException(403, YOUTUBE_OFF_MSG)
        job_id = new_job_id()
        title = None
    elif kind == "file":
        if not file:
            raise HTTPException(400, "file wajib diupload")
        job_id = new_job_id()
        name = safe_name(file.filename or "audio")
        dst = DATA / job_id / f"upload_{name}"
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        title = Path(file.filename or name).stem
        source = {"type": "file", "path": dst.name, "title": title}  # relative to the job folder
    else:
        raise HTTPException(400, "kind tidak dikenal")

    meta = write_meta(job_id, id=job_id, title=title, source=source, source_type=source["type"],
                      status="queued", stage="Menunggu unduhan", progress=0.0, created=time.time())
    download_pool.submit(download_stage, job_id)
    return public(meta)


def analysis_info(job_id: str, meta: dict) -> dict:
    """when the current result was produced and whether it predates the latest pipeline."""
    p = DATA / job_id / "analysis.json"
    if not p.exists():
        return {}
    at = meta.get("finished") or p.stat().st_mtime  # older jobs: fall back to file time
    return {"analyzed_at": at, "outdated": (meta.get("version") or 0) < PIPELINE_VERSION}


def public(meta: dict) -> dict:
    """drop the source (may hold local file paths), keep only the url."""
    out = dict(meta)
    out["url"] = (out.pop("source", None) or {}).get("url")
    if out.get("id"):
        out.update(analysis_info(out["id"], meta))
    return out


@app.get("/api/jobs")
def list_jobs():
    jobs = [public(j) for j in with_queue_info(all_meta())]
    return sorted(jobs, key=lambda m: m.get("created", 0), reverse=True)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return public(read_meta(job_id))


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    if not ALLOW_ANALYSIS:
        raise HTTPException(403, NO_ANALYSIS_MSG)
    meta = read_meta(job_id)
    if meta.get("status") != "error":
        raise HTTPException(400, "hanya job yang gagal yang bisa dicoba lagi")
    if "source" not in meta:
        raise HTTPException(400, "job lama tanpa info sumber, silakan tambahkan ulang")
    enqueue(job_id, meta)
    return public(read_meta(job_id))


@app.post("/api/jobs/{job_id}/reanalyze")
def reanalyze_job(job_id: str):
    """run the latest pipeline again on a finished song (re-downloads links)."""
    if not ALLOW_ANALYSIS:
        raise HTTPException(403, NO_ANALYSIS_MSG)
    meta = read_meta(job_id)
    if meta.get("status") in ACTIVE:
        raise HTTPException(400, "lagu ini masih di antrian")
    src = meta.get("source")
    if not src:
        raise HTTPException(400, "info sumber tidak ada, silakan tambahkan ulang")
    if src["type"] == "file" and not upload_path(job_id, src).exists():
        raise HTTPException(400, "file asli sudah tidak tersimpan, silakan upload ulang")
    if src["type"] == "youtube" and not ALLOW_YOUTUBE and not cached_download(source_key(src) or "", CACHE):
        raise HTTPException(403, YOUTUBE_OFF_MSG)
    write_meta(job_id, created=time.time())
    enqueue(job_id, meta)
    return public(read_meta(job_id))


layers_lock = threading.Lock()


def add_layers(job_id: str, path: Path, data: dict) -> dict:
    """older results lack the multitrack layers; build them once from the saved stem mp3s."""
    with layers_lock:
        fresh = json.loads(path.read_text())
        layers = fresh.get("layers")
        if layers and layers.get("drums") is not None and layers.get("drums_v", 1) < DRUM_VERSION:
            # only the drum hits changed: rebuild them (and the drum midi) from the saved stem
            drums_mp3 = DATA / job_id / "drums.mp3"
            if drums_mp3.exists():
                try:
                    layers["drums"] = drum_hits(drums_mp3)
                    layers["drums_v"] = DRUM_VERSION
                    if (DATA / job_id / "drums.mid").exists():
                        write_drum_midi(layers["drums"], fresh.get("bpm") or 120, DATA / job_id / "drums.mid")
                    path.write_text(json.dumps(fresh))
                except Exception:
                    traceback.print_exc()
            return fresh
        if layers:
            return fresh
        stems = {name: DATA / job_id / f for name, f in (fresh.get("audio") or {}).items()}
        if not stems or not all(p.exists() for p in stems.values()):
            return data
        try:
            fresh["layers"] = stem_layers(stems)
        except Exception:
            traceback.print_exc()
            return data
        path.write_text(json.dumps(fresh))
        return fresh


@app.get("/api/jobs/{job_id}/analysis")
def get_analysis(job_id: str):
    p = DATA / job_id / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "analisis belum siap")
    data = json.loads(p.read_text())
    if "layers" not in data or (data["layers"].get("drums") is not None and data["layers"].get("drums_v", 1) < DRUM_VERSION):
        data = add_layers(job_id, p, data)
    meta = read_meta(job_id)
    data.update(analysis_info(job_id, meta))
    data["url"] = (meta.get("source") or {}).get("url")
    data["source_type"] = meta.get("source_type")
    return data


@app.get("/api/jobs/{job_id}/files/{name}")
def get_file(job_id: str, name: str):
    if name not in PUBLIC_JOB_FILES:
        raise HTTPException(404)
    p = DATA / job_id / name
    if not p.exists():
        raise HTTPException(404)
    meta = read_meta(job_id)
    if name.endswith(".mid"):
        part = {"vocals": "vokal", "guitar": "gitar", "piano": "piano", "drums": "drum"}.get(name[:-4], "bass")
        return FileResponse(p, filename=f"{safe_name(meta.get('title') or part)} - {part}.mid")
    return FileResponse(p)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str, request: Request):
    if not ALLOW_ANALYSIS:
        check_token(request)  # view-only server: only publish.sh may remove songs
    meta = read_meta(job_id)
    if meta.get("status") in ("downloading", "running"):
        # worker stops at its next checkpoint and removes the folder
        cancelled.add(job_id)
        write_meta(job_id, stage="Membatalkan…")
    else:
        shutil.rmtree(DATA / job_id, ignore_errors=True)
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "bass": True, "mode": MODE, "youtube": ALLOW_YOUTUBE and ALLOW_ANALYSIS,
            "analysis": ALLOW_ANALYSIS, "version": PIPELINE_VERSION}


# ---------------------------------------------------------------- publish (mac -> view-only server)

def check_token(request: Request) -> None:
    if not PUBLISH_TOKEN:
        raise HTTPException(403, "publish belum diaktifkan di server ini (ENCORE_PUBLISH_TOKEN kosong)")
    got = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(got.encode(), PUBLISH_TOKEN.encode()):
        raise HTTPException(401, "token publish salah")


@app.post("/api/publish/{job_id}")
async def publish_job(job_id: str, request: Request, files: list[UploadFile] = File(...)):
    """receive a finished song from publish.sh and swap it in whole."""
    check_token(request)
    if not re.fullmatch(r"[0-9a-f]{10}", job_id):
        raise HTTPException(400, "id job tidak valid")
    names = {f.filename for f in files}
    if not {"meta.json", "analysis.json"} <= names or not names <= PUBLISH_FILES:
        raise HTTPException(400, "file publish tidak lengkap atau tidak dikenal")
    meta = json.loads(await next(f for f in files if f.filename == "meta.json").read())
    if meta.get("id") != job_id or meta.get("status") != "done":
        raise HTTPException(400, "hanya lagu yang sudah selesai dianalisis yang bisa di-publish")

    stage = INCOMING / job_id
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    for f in files:
        await f.seek(0)
        with (stage / f.filename).open("wb") as out:
            shutil.copyfileobj(f.file, out)
    # keep only what a viewer needs: no local paths, no queue state
    src = meta.get("source") or {}
    meta["source"] = {k: v for k, v in src.items() if k in ("type", "url", "title")}
    meta.update(published=time.time(), reanalyze_error=None)
    (stage / "meta.json").write_text(json.dumps(meta))

    dst, old = DATA / job_id, INCOMING / f"{job_id}.old"
    with lock:
        shutil.rmtree(old, ignore_errors=True)
        if dst.exists():
            dst.rename(old)
        stage.rename(dst)
    shutil.rmtree(old, ignore_errors=True)
    return public(meta)


# ---------------------------------------------------------------- drive audio + titles (playlist)

DRIVE_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")


def open_drive(file_id: str, rng: str | None):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def req(u: str):
        r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", **({"Range": rng} if rng else {})})
        return opener.open(r, timeout=30)

    resp = req("https://drive.usercontent.google.com/download?" + urllib.parse.urlencode({"id": file_id, "export": "download"}))
    if resp.headers.get_content_type() == "text/html":
        # large files show a virus-scan confirmation page; follow its form
        page = resp.read().decode("utf-8", "ignore")
        fields = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', page))
        if "confirm" not in fields:
            raise PermissionError("File tidak publik atau bukan file yang bisa diunduh.")
        resp = req("https://drive.usercontent.google.com/download?" + urllib.parse.urlencode(fields))
    return resp


@app.get("/drive")
def drive(id: str, request: Request):
    if not re.fullmatch(r"[\w-]{10,}", id):
        raise HTTPException(400, "Bad id")
    try:
        resp = open_drive(id, request.headers.get("range"))
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code, "Drive error")
    except Exception as e:
        raise HTTPException(403, str(e))
    headers = {h: resp.headers[h] for h in DRIVE_HEADERS if resp.headers.get(h)}
    headers.setdefault("Accept-Ranges", "bytes")

    def body():
        try:
            while chunk := resp.read(64 * 1024):
                yield chunk
        finally:
            resp.close()

    return StreamingResponse(body(), status_code=resp.status, headers=headers)


TITLES: dict[tuple[str, str], str | None] = {}


def lookup_title(kind: str, file_id: str) -> str | None:
    try:
        if kind == "yt":
            url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + file_id)
            with urllib.request.urlopen(url, timeout=10) as r:
                return json.load(r).get("title")
        req = urllib.request.Request(f"https://drive.google.com/file/d/{file_id}/view", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            m = re.search(r"<title>(.*?)</title>", r.read(200000).decode("utf-8", "ignore"), re.S)
        if not m:
            return None
        title = html.unescape(m.group(1)).removesuffix(" - Google Drive").strip()
        if title in ("", "Google Drive", "Google Drive: Sign-in"):
            return None
        return title.rsplit(".", 1)[0] if "." in title else title
    except Exception:
        return None


@app.get("/title")
def title(type: str, id: str):
    if type not in ("yt", "drive") or not re.fullmatch(r"[\w-]{6,}", id):
        raise HTTPException(400, "Bad request")
    if (type, id) not in TITLES:
        TITLES[(type, id)] = lookup_title(type, id)
    return JSONResponse({"title": TITLES[(type, id)]})


# ---------------------------------------------------------------- web app

@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/{name}")
def root_file(name: str):
    if name not in PUBLIC_FILES:
        raise HTTPException(404)
    return FileResponse(ROOT / name)


app.mount("/app", StaticFiles(directory=ROOT / "app"), name="app")


# resume unfinished jobs after a restart, oldest first
for _m in sorted(all_meta(), key=lambda m: m.get("created", 0)):
    if _m.get("status") in ACTIVE:
        if "source" not in _m:
            write_meta(_m["id"], status="error", stage="Gagal", error="job lama tanpa info sumber, tambahkan ulang")
        else:
            enqueue(_m["id"], _m)

