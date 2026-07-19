import json
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.discard(websocket)

    async def broadcast(self, event: str, payload: Any | None = None) -> None:
        message = json.dumps({"event": event, "payload": payload}, default=str, ensure_ascii=False)
        dead: list[WebSocket] = []
        for websocket in list(self.active_connections):
            try:
                await websocket.send_text(message)
            except RuntimeError:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(websocket)


manager = ConnectionManager()
