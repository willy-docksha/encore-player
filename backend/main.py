"""encore app: starts the local server and opens encore in the default browser.

run from source:  .venv/bin/python backend/main.py
packaged:         pyinstaller backend/encore.spec (see README "Encore App")
"""

from __future__ import annotations

import json
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PORT = int(os.environ.get("PORT") or 8765)


def use_bundled_certificates() -> None:
    """the packaged python can't read the system certificate store: use certifi's for https
    (drive, youtube, ai engine and model downloads; the engine inherits it)."""
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ImportError:
        pass


def running_app(port: int) -> bool:
    """true when an encore app already answers on this port."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return bool(json.load(r).get("app"))
    except Exception:
        return False


def port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port() -> int:
    for port in range(PORT, PORT + 20):
        if port_free(port):
            return port
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_when_ready(url: str) -> None:
    for _ in range(600):
        try:
            urllib.request.urlopen(url + "api/health", timeout=1).close()
            break
        except Exception:
            time.sleep(0.2)
    webbrowser.open(url + "#/breakdown")


def run_mac_app(url: str, serve) -> None:
    """packaged mac app: a dock icon that reopens encore when clicked and quits from the dock menu."""
    from AppKit import NSApplication, NSApplicationActivationPolicyRegular
    from Foundation import NSObject

    class Delegate(NSObject):
        def applicationShouldHandleReopen_hasVisibleWindows_(self, _app, _flag):
            webbrowser.open(url + "#/breakdown")
            return True

    app = NSApplication.sharedApplication()
    delegate = Delegate.alloc().init()
    app.setDelegate_(delegate)
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    threading.Thread(target=serve, daemon=True).start()
    app.run()


def main() -> None:
    use_bundled_certificates()
    # a second launch just opens the window of the one already running
    if running_app(PORT):
        webbrowser.open(f"http://localhost:{PORT}/#/breakdown")
        return

    # the windowed mac app has no terminal: keep the log in the app data folder
    if sys.stdout is None or sys.stderr is None:
        from app import data_dir

        log = open(Path(data_dir()) / "encore.log", "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log

    print("Menyiapkan Encore… (pertama kali bisa agak lama)")
    import uvicorn

    from app import app

    port = pick_port()
    url = f"http://localhost:{port}/"
    threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    print(f"Encore jalan di {url}")

    def serve():
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", log_config=None)

    if getattr(sys, "frozen", False) and sys.platform == "darwin":
        run_mac_app(url, serve)
        return
    print("Biarkan jendela ini terbuka selama memakai Encore. Tutup jendela ini (atau tombol Tutup Encore App) untuk berhenti.")
    serve()


if __name__ == "__main__":
    # pyin runs in worker processes; the packaged app must let them start
    multiprocessing.freeze_support()
    main()
