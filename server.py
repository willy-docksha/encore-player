#!/usr/bin/env python3
"""Encore Player: serves index.html and proxies Google Drive audio at /drive?id=FILE_ID."""
import http.server, html, json, re, sys, urllib.parse, urllib.request, http.cookiejar

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
HEADERS_OUT = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")

def open_drive(file_id, rng):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    url = "https://drive.usercontent.google.com/download?" + urllib.parse.urlencode({"id": file_id, "export": "download"})
    def req(u):
        r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", **({"Range": rng} if rng else {})})
        return opener.open(r, timeout=30)
    resp = req(url)
    if resp.headers.get_content_type() == "text/html":
        # Large files show a virus-scan confirmation page; follow its form.
        page = resp.read().decode("utf-8", "ignore")
        fields = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', page))
        if "confirm" not in fields:
            raise PermissionError("File tidak publik atau bukan file yang bisa diunduh.")
        resp = req("https://drive.usercontent.google.com/download?" + urllib.parse.urlencode(fields))
    return resp

TITLES = {}

def get_title(kind, file_id):
    key = (kind, file_id)
    if key not in TITLES:
        title = None
        try:
            if kind == "yt":
                url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + file_id)
                with urllib.request.urlopen(url, timeout=10) as r:
                    title = json.load(r).get("title")
            else:
                req = urllib.request.Request(f"https://drive.google.com/file/d/{file_id}/view", headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    m = re.search(r"<title>(.*?)</title>", r.read(200000).decode("utf-8", "ignore"), re.S)
                if m:
                    title = html.unescape(m.group(1)).removesuffix(" - Google Drive").strip()
                    if title in ("", "Google Drive", "Google Drive: Sign-in"):
                        title = None
                    elif "." in title:
                        title = title.rsplit(".", 1)[0]
        except Exception:
            pass
        TITLES[key] = title
    return TITLES[key]

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/title":
            q = urllib.parse.parse_qs(u.query)
            kind, file_id = q.get("type", [""])[0], q.get("id", [""])[0]
            if kind not in ("yt", "drive") or not re.fullmatch(r"[\w-]{6,}", file_id):
                return self.send_error(400, "Bad request")
            body = json.dumps({"title": get_title(kind, file_id)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path != "/drive":
            return super().do_GET()
        file_id = urllib.parse.parse_qs(u.query).get("id", [""])[0]
        if not re.fullmatch(r"[\w-]{10,}", file_id):
            return self.send_error(400, "Bad id")
        try:
            resp = open_drive(file_id, self.headers.get("Range"))
        except urllib.error.HTTPError as e:
            return self.send_error(e.code if e.code != 416 else 416)
        except Exception as e:
            return self.send_error(403, str(e))
        self.send_response(resp.status)
        for h in HEADERS_OUT:
            if resp.headers.get(h):
                self.send_header(h, resp.headers[h])
        if not resp.headers.get("Accept-Ranges"):
            self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        try:
            while chunk := resp.read(64 * 1024):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    print(f"Encore Player jalan di http://localhost:{PORT}  (tutup jendela ini untuk berhenti)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
