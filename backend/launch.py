"""Desktop service entry point. The parent keeps stdin open for our lifetime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import threading


def main():
    options = json.loads(sys.stdin.readline())
    data = Path(options["dataDirectory"])
    database = Path(options["databasePath"])
    if options.get("nativeSSH"):
        os.environ["MOSSENTRY_SSH_ENGINE"] = "native"
    os.environ.update({
        "MOSSENTRY_DATA_DIR": str(data),
        "MOSSENTRY_DB_PATH": str(database),
        "MOSSENTRY_DESKTOP_TOKEN": options["token"],
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
    })

    import uvicorn
    server = uvicorn.Server(uvicorn.Config("app.main:app", host="127.0.0.1", port=int(options["port"]),
                                          loop="asyncio", http="h11", access_log=False, timeout_graceful_shutdown=5))

    def watch_parent():
        try:
            while sys.stdin.buffer.read(1):
                pass
        except (OSError, ValueError):
            pass
        finally:
            server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
