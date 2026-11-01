#!/usr/bin/env python3
"""memento.py — a complete JSMemento client in Python (3.9+, standard library).

It does three things, in this order:
  1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
  2. query   the last 10 events of user/<you>;
  3. tail    the live stream of user/<you> for 10 seconds — when the `websockets`
             package is installed (pip install websockets); otherwise it says so.

Environment:
  MEMENTO_API_KEY  your API key with the read and write scopes (required)
  MEMENTO_URL      the API base, default https://service.stage.memento-service.org/memento

Run:
  MEMENTO_API_KEY=mk_… python3 memento.py
"""

import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "https://service.stage.memento-service.org/memento"
BASE_URL = (os.environ.get("MEMENTO_URL") or DEFAULT_URL).rstrip("/")
API_KEY = os.environ.get("MEMENTO_API_KEY", "")
TAIL_SECONDS = 10


class ApiError(Exception):
    pass


def post(path, body):
    """POST a JSON body to the API and return the envelope's `data`; raises ApiError."""
    request = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)["data"]
    except urllib.error.HTTPError as error:
        try:
            message = json.load(error)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            message = error.reason
        raise ApiError(f"HTTP {error.code}: {message}") from None
    except urllib.error.URLError as error:
        raise ApiError(f"Cannot reach {BASE_URL}: {error.reason}") from None


def push(user):
    """1. Push one event; returns the stored event."""
    event = post(
        "/events",
        {
            "event_type": "USER_LOGIN",
            "instance_type": "user",
            "instance_id": user,
            "actor_id": user,
            "payload": {"ip": "127.0.0.1", "client": "python"},
        },
    )
    print(f"Pushed {event['id']}")
    print(f"  {event['rendered']}")
    return event


def query(user):
    """2. The last 10 events of user/<user>, newest first."""
    events = post(
        "/events/query",
        {
            "filter": {
                "and": [
                    {"field": "instance_type", "op": "eq", "value": "user"},
                    {"field": "instance_id", "op": "eq", "value": user},
                ]
            },
            "limit": 10,
        },
    )
    print(f"\nLatest events of user/{user}:")
    for event in events:
        print(f"  {event['occurred_at']}  {event['event_type']}  {event['rendered'] or ''}")


def tail(user):
    """3. Print every new event of user/<user> for TAIL_SECONDS seconds."""
    try:
        from websockets.exceptions import ConnectionClosed, InvalidStatus
        from websockets.sync.client import connect
    except ImportError:
        print("\nTail: not in this sample without the websockets package ≥ 14 (pip install websockets).")
        return

    params = urllib.parse.urlencode({"instance_type": "user", "instance_id": user, "locale": "en"})
    url = BASE_URL.replace("http", "ws", 1) + "/ws?" + params
    deadline = time.monotonic() + TAIL_SECONDS
    try:
        # The key travels as a subprotocol; the server answers with `memento.v1`.
        with connect(url, subprotocols=["memento.v1", f"bearer.{API_KEY}"]) as socket:
            while (remaining := deadline - time.monotonic()) > 0:
                try:
                    frame = json.loads(socket.recv(timeout=remaining))
                except TimeoutError:
                    break
                if frame["kind"] == "memento.welcome":
                    print(f"\nTailing user/{user} for {TAIL_SECONDS} s …", flush=True)
                elif frame["kind"] == "memento.event.new":
                    event = frame["payload"]
                    print(f"  {event['rendered'] or event['event_type']}", flush=True)
                # anything else (memento.pong, …) is ignored
    except InvalidStatus as error:
        raise ApiError(f"Tail: HTTP {error.response.status_code} from the stream") from None
    except (OSError, ConnectionClosed) as error:
        raise ApiError(f"Tail: the stream failed: {error}") from None
    print("Done.")


def main():
    if not API_KEY:
        print(
            "Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)",
            file=sys.stderr,
        )
        sys.exit(2)
    user = getpass.getuser()
    try:
        push(user)
        query(user)
        tail(user)
    except ApiError as error:
        print(error, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
