"""Client pour l API RINA AI hebergee sur plateforme-rina.com.

Authentification via la variable d environnement RINA_API_KEY :
    export RINA_API_KEY=sk-...

Usage:
    python demo/api_client.py --prompt "Ecris une fonction de tri rapide"
    python demo/api_client.py --prompt "Explique ce code" --stream
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterator
from urllib import error, request

DEFAULT_BASE_URL = "https://api.plateforme-rina.com"
DEFAULT_MODEL = "rina-coder-base"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Client API RINA AI")
    p.add_argument("--prompt", required=True)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--max-tokens", type=int, default=512)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--stream", action="store_true", help="Streaming token par token")
    p.add_argument(
        "--base-url",
        default=os.environ.get("RINA_BASE_URL", DEFAULT_BASE_URL),
    )
    return p.parse_args()


def get_api_key() -> str:
    key = os.environ.get("RINA_API_KEY")
    if not key:
        print(
            "RINA_API_KEY n'est pas defini. Recupere une cle sur "
            "https://plateforme-rina.com/account.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return key


def post(base_url: str, path: str, payload: dict, api_key: str, stream: bool) -> Iterator[bytes]:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        base_url.rstrip("/") + path,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": "rina-ai-cli/0.1",
        },
    )
    try:
        with request.urlopen(req, timeout=120) as resp:
            if stream:
                yield from resp
            else:
                yield resp.read()
    except error.HTTPError as e:
        print(f"HTTP {e.code} : {e.read().decode('utf-8', errors='replace')}", file=sys.stderr)
        raise SystemExit(1) from e
    except error.URLError as e:
        print(f"Erreur reseau : {e}", file=sys.stderr)
        raise SystemExit(1) from e


def generate(args, api_key: str) -> None:
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "stream": args.stream,
    }

    if args.stream:
        for raw in post(args.base_url, "/v1/generate", payload, api_key, stream=True):
            line = raw.decode("utf-8", errors="replace").strip()
            if not line or not line.startswith("data:"):
                continue
            chunk = line[len("data:") :].strip()
            if chunk == "[DONE]":
                print()
                return
            try:
                event = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            piece = event.get("delta") or event.get("text") or ""
            sys.stdout.write(piece)
            sys.stdout.flush()
        print()
    else:
        for raw in post(args.base_url, "/v1/generate", payload, api_key, stream=False):
            data = json.loads(raw.decode("utf-8"))
            text = data.get("output") or data.get("text") or json.dumps(data, indent=2)
            print(text)


def main() -> int:
    args = parse_args()
    api_key = get_api_key()
    generate(args, api_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
