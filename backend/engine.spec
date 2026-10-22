# pyinstaller spec for the ai engine: pyinstaller backend/engine.spec (run from the repo root)
# -> dist/EncoreAI/EncoreAI(.exe), a command line program the app downloads and starts (backend/ai.py)

from pathlib import Path

from PyInstaller.utils.hooks import collect_all

ROOT = Path(SPECPATH).parent
datas, binaries, hiddenimports = [], [], []
# packages that load model configs, stubs or binaries from their own folder
for pkg in ("demucs", "beat_this", "basic_pitch", "librosa", "imageio_ffmpeg", "rotary_embedding_torch"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [str(ROOT / "backend" / "engine.py")],
    pathex=[str(ROOT / "backend")],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    # the engine needs no web server, downloader or optional extras
    excludes=["fastapi", "uvicorn", "starlette", "yt_dlp", "tensorflow", "coremltools", "tflite_runtime", "matplotlib",
              "tkinter", "IPython", "notebook", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="EncoreAI", console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="EncoreAI", upx=False)
