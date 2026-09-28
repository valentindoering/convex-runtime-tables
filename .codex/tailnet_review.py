"""Worktree-owned Tailscale Serve review links (stdlib only, also vendorable)."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
import random
import re
import shlex
import shutil
import socket
import subprocess
import sys
from pathlib import Path


def _home() -> Path:
    path = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "rdu-review"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _state_path(root: Path) -> Path:
    return _home() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:24] + ".json")


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["tailscale", *args], text=True, capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        return subprocess.CompletedProcess(args, 1, "", str(error))


def _connection() -> str | None:
    if not shutil.which("tailscale"):
        return None
    result = _run("status", "--json")
    if result.returncode:
        return None
    try:
        data = json.loads(result.stdout)
        if data.get("BackendState") != "Running":
            return None
        return data["Self"]["DNSName"].rstrip(".")
    except (KeyError, TypeError, ValueError):
        return None


def _serve_config() -> dict:
    result = _run("serve", "status", "--json")
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "tailscale serve status failed")
    try:
        return json.loads(result.stdout or "{}")
    except ValueError as error:
        raise RuntimeError("tailscale serve returned invalid JSON") from error


def _ports(config: dict) -> set[int]:
    ports: set[int] = set()
    for key in config.get("TCP", {}):
        if str(key).isdigit():
            ports.add(int(key))
    for key in config.get("Web", {}):
        match = re.search(r":(\d+)$", key)
        if match:
            ports.add(int(match.group(1)))
    for key in config.get("AllowFunnel", {}):
        match = re.search(r":(\d+)$", key)
        if match:
            ports.add(int(match.group(1)))
    return ports


def _proxy(config: dict, port: int) -> str | None:
    for key, web in config.get("Web", {}).items():
        if key.endswith(f":{port}"):
            return web.get("Handlers", {}).get("/", {}).get("Proxy")
    return None


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {"services": {}}


def _write(path: Path, value: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def _target(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _matches(config: dict, external: int, internal: int) -> bool:
    return _proxy(config, external) in {_target(internal), f"http://localhost:{internal}"}


def _print_links(host: str, state: dict) -> None:
    for name, value in state.get("services", {}).items():
        print(f"Tailnet {name}: https://{host}:{value['external']}/")


def _prune_missing_roots(config: dict, current: Path) -> None:
    """Retry cleanup after a worktree vanished while Tailscale was offline."""
    for path in _home().glob("*.json"):
        if path == current:
            continue
        state = _load(path)
        root = state.get("root")
        if not root or Path(root).exists():
            continue
        services = state.get("services", {})
        for name, value in list(services.items()):
            if _matches(config, value["external"], value["internal"]):
                result = _run("serve", f"--https={value['external']}", "off")
                if result.returncode:
                    continue
            services.pop(name)
        if services:
            _write(path, state)
        else:
            path.unlink(missing_ok=True)


def manage(root: Path, action: str, services: dict[str, int] | None = None,
           reconcile: bool = False) -> dict[str, str]:
    """Start, inspect, or stop only this root's Serve endpoints.

    Returns advertised URLs. Missing/disconnected Tailscale is a normal no-op.
    """
    root = root.resolve()
    path = _state_path(root)
    with (_home() / ".lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = _load(path)
        host = _connection()
        if not host:
            print("Tailnet review unavailable: Tailscale is absent or disconnected; local development continues.")
            return {}
        try:
            config = _serve_config()
        except RuntimeError as error:
            print(f"Tailnet review unavailable: {error}; local development continues.")
            return {}
        _prune_missing_roots(config, path)
        old = state.get("services", {})
        if action == "down":
            for name, value in list(old.items()):
                external, internal = value["external"], value["internal"]
                if _matches(config, external, internal):
                    result = _run("serve", f"--https={external}", "off")
                    if result.returncode:
                        print(f"Could not stop Tailnet {name}: {result.stderr.strip()}", file=sys.stderr)
                        continue
                old.pop(name)
            if old:
                _write(path, state)
            else:
                path.unlink(missing_ok=True)
            return {}
        if action == "status":
            active = {name: value for name, value in old.items() if _matches(config, value["external"], value["internal"])}
            _print_links(host, {"services": active})
            return {name: f"https://{host}:{value['external']}" for name, value in active.items()}
        if action != "up":
            raise ValueError(action)
        services = services or {}
        used = _ports(config)
        for name, internal in services.items():
            if not (1 <= internal <= 65535):
                raise ValueError(f"Invalid port for {name}: {internal}")
            previous = old.get(name)
            if previous and previous["internal"] == internal and _matches(config, previous["external"], internal):
                continue
            if previous and _matches(config, previous["external"], previous["internal"]):
                result = _run("serve", f"--https={previous['external']}", "off")
                if result.returncode:
                    print(f"Could not replace Tailnet {name}: {result.stderr.strip()}", file=sys.stderr)
                    continue
                used.discard(previous["external"])
            old.pop(name, None)
            # External ports are separate from service ports and globally serialized.
            def available(port: int) -> bool:
                with socket.socket() as probe:
                    probe.settimeout(0.05)
                    return probe.connect_ex(("127.0.0.1", port)) != 0

            candidate = next((p for p in random.sample(range(42000, 62000), 20000)
                              if p not in used and p not in services.values() and available(p)), None)
            if candidate is None:
                print("No free Tailscale Serve port", file=sys.stderr)
                continue
            result = _run("serve", "--bg", f"--https={candidate}", _target(internal))
            if result.returncode:
                detail = result.stderr.strip() or result.stdout.strip()
                print(f"Tailnet review unavailable for {name}: {detail}", file=sys.stderr)
                print("Enable HTTPS/Serve for this tailnet in the Tailscale admin console, then rerun review up.", file=sys.stderr)
                continue
            used.add(candidate)
            old[name] = {"external": candidate, "internal": internal}
            _write(path, {"root": str(root), "services": old})
        # Do not remove an endpoint merely because a caller omitted it.
        _write(path, {"root": str(root), "services": old})
        if any(name not in old for name in services):
            print("Tailnet review incomplete; keeping all browser URLs local.", file=sys.stderr)
            try:
                refreshed = _serve_config()
            except RuntimeError:
                refreshed = None
            for name, value in list(old.items()):
                if name not in services:
                    continue
                if refreshed is None:
                    continue
                if _matches(refreshed, value["external"], value["internal"]):
                    result = _run("serve", f"--https={value['external']}", "off")
                    if result.returncode:
                        continue
                old.pop(name)
            _write(path, {"root": str(root), "services": old})
            return {}
        if reconcile:
            for name, value in list(old.items()):
                if name in services:
                    continue
                if _matches(config, value["external"], value["internal"]):
                    result = _run("serve", f"--https={value['external']}", "off")
                    if result.returncode:
                        print(f"Could not stop retired Tailnet {name}: {result.stderr.strip()}", file=sys.stderr)
                        continue
                old.pop(name)
            _write(path, {"root": str(root), "services": old})
        active = {name: value for name, value in old.items() if name in services}
        _print_links(host, {"services": active})
        return {name: f"https://{host}:{value['external']}" for name, value in active.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Worktree-owned Tailscale Serve review links")
    parser.add_argument("action", choices=("up", "down", "status"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--service", action="append", default=[], metavar="NAME=PORT")
    parser.add_argument("--detect", action="append", default=[], metavar="NAME=COMMAND",
                        help="Run a status command and use its first loopback HTTP URL")
    parser.add_argument("--json", action="store_true", help="Print only the service URL map as JSON")
    args = parser.parse_args()
    services = {}
    for spec in args.service:
        name, sep, port = spec.partition("=")
        if not sep or not name or not port.isdigit():
            parser.error(f"invalid service {spec!r}; expected NAME=PORT")
        services[name] = int(port)
    if args.action == "up" and _connection():
        for spec in args.detect:
            name, sep, command = spec.partition("=")
            if not sep or not name or not command:
                parser.error(f"invalid detect {spec!r}; expected NAME=COMMAND")
            try:
                status = subprocess.run(shlex.split(command), cwd=args.root, text=True,
                                        capture_output=True, timeout=15)
                match = re.search(r"https?://(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)", status.stdout)
                if status.returncode == 0 and match:
                    services[name] = int(match.group(1))
                else:
                    print(f"Tailnet {name}: status command did not report a loopback HTTP URL", file=sys.stderr)
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                print(f"Tailnet {name}: status command failed: {error}", file=sys.stderr)
    if args.json:
        with contextlib.redirect_stdout(io.StringIO()):
            urls = manage(args.root, args.action, services)
        print(json.dumps(urls))
    else:
        manage(args.root, args.action, services)


if __name__ == "__main__":
    main()
