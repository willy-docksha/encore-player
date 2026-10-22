# pyinstaller spec for the encore app: pyinstaller backend/encore.spec (run from the repo root)
# mac -> dist/Encore.app, windows -> dist/Encore/Encore.exe, linux -> dist/Encore/Encore

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
MAC = sys.platform == "darwin"
WIN = sys.platform == "win32"

# the web app, served from the bundle root
datas = [(str(ROOT / "index.html"), "."), (str(ROOT / "sw.js"), "."), (str(ROOT / "manifest.webmanifest"), "."),
         (str(ROOT / "app"), "app")]
datas += [(str(p), ".") for p in ROOT.glob("icon-*.png")]
binaries = []
hiddenimports = collect_submodules("uvicorn")

# packages that load model configs, stubs or binaries from their own folder
for pkg in ("demucs", "beat_this", "basic_pitch", "librosa", "imageio_ffmpeg", "yt_dlp_ejs", "rotary_embedding_torch"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("lazy_loader")

a = Analysis(
    [str(ROOT / "backend" / "main.py")],
    pathex=[str(ROOT / "backend")],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    # big optional extras nothing here uses
    excludes=["tensorflow", "coremltools", "tflite_runtime", "matplotlib", "tkinter", "IPython", "notebook", "pytest"],
)
pyz = PYZ(a.pure)
icon = str(ROOT / "icon-512.png")
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Encore",
    # windows / linux keep a terminal window: closing it stops encore
    console=not MAC,
    icon=icon,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Encore", upx=False)
if MAC:
    app = BUNDLE(
        coll,
        name="Encore.app",
        icon=icon,
        bundle_identifier="id.encore.app",
        info_plist={"CFBundleShortVersionString": "1.0.0", "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "12.0"},
    )
