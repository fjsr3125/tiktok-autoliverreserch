import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer


PORT = int(os.environ.get("BROWSER_CONTROL_PORT", "3002"))


def run_supervisorctl(args):
    return subprocess.run(
        ["/usr/bin/supervisorctl", *args],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            json_response(self, 404, {"error": "Not found"})
            return

        try:
            result = run_supervisorctl(["status", "chrome"])
            status = result.stdout.strip()
            json_response(self, 200, {"ok": "RUNNING" in status, "chrome": status})
        except Exception as error:
            json_response(self, 500, {"ok": False, "error": str(error)})

    def do_POST(self):
        if self.path != "/restart-chrome":
            json_response(self, 404, {"error": "Not found"})
            return

        try:
            run_supervisorctl(["restart", "chrome"])
            result = run_supervisorctl(["status", "chrome"])
            json_response(self, 200, {"ok": True, "chrome": result.stdout.strip()})
        except subprocess.CalledProcessError as error:
            json_response(
                self,
                500,
                {
                    "ok": False,
                    "error": str(error),
                    "stdout": error.stdout or "",
                    "stderr": error.stderr or "",
                },
            )
        except Exception as error:
            json_response(self, 500, {"ok": False, "error": str(error)})

    def log_message(self, format, *args):
        print(f"[browser-control] {self.address_string()} {format % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[browser-control] listening on {PORT}")
    server.serve_forever()
