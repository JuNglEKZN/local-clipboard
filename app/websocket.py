import json
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect


@dataclass
class Peer:
    id: str
    websocket: WebSocket
    name: str = "Устройство"
    device_type: str = "desktop"
    registered: bool = False


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: set[WebSocket] = set()
        self.peers: dict[str, Peer] = {}
        self.websocket_peers: dict[WebSocket, str] = {}

    async def connect(self, websocket: WebSocket) -> str:
        await websocket.accept()
        self.active_connections.add(websocket)
        peer_id = uuid4().hex
        self.peers[peer_id] = Peer(id=peer_id, websocket=websocket)
        self.websocket_peers[websocket] = peer_id
        await self.send(websocket, "peer_identity", {"id": peer_id})
        return peer_id

    async def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.discard(websocket)
        peer_id = self.websocket_peers.pop(websocket, None)
        if peer_id:
            self.peers.pop(peer_id, None)
            await self.broadcast_peer_lists()

    async def send(self, websocket: WebSocket, event: str, payload: Any | None = None) -> None:
        message = json.dumps({"event": event, "payload": payload}, default=str, ensure_ascii=False)
        await websocket.send_text(message)

    async def register_peer(self, websocket: WebSocket, name: str, device_type: str) -> None:
        peer_id = self.websocket_peers.get(websocket)
        peer = self.peers.get(peer_id or "")
        if peer is None:
            return
        clean_name = " ".join(str(name).split())[:40]
        peer.name = clean_name or "Устройство"
        peer.device_type = device_type if device_type in {"phone", "tablet", "desktop"} else "desktop"
        peer.registered = True
        await self.broadcast_peer_lists()

    async def relay(self, websocket: WebSocket, target_id: str, signal: dict[str, Any]) -> None:
        sender_id = self.websocket_peers.get(websocket)
        sender = self.peers.get(sender_id or "")
        target = self.peers.get(target_id)
        if sender is None or target is None or not sender.registered or not target.registered:
            return
        try:
            await self.send(target.websocket, "peer_signal", {"from": sender.id, "signal": signal})
        except (RuntimeError, WebSocketDisconnect):
            self._remove(target.websocket)
            await self.broadcast_peer_lists()

    async def broadcast_peer_lists(self) -> None:
        registered = [peer for peer in self.peers.values() if peer.registered]
        dead: list[WebSocket] = []
        for recipient in registered:
            items = [
                {"id": peer.id, "name": peer.name, "device_type": peer.device_type}
                for peer in registered
                if peer.id != recipient.id
            ]
            try:
                await self.send(recipient.websocket, "peers_changed", {"items": items})
            except (RuntimeError, WebSocketDisconnect):
                dead.append(recipient.websocket)
        for websocket in dead:
            self._remove(websocket)

    def _remove(self, websocket: WebSocket) -> None:
        self.active_connections.discard(websocket)
        peer_id = self.websocket_peers.pop(websocket, None)
        if peer_id:
            self.peers.pop(peer_id, None)

    async def broadcast(self, event: str, payload: Any | None = None) -> None:
        message = json.dumps({"event": event, "payload": payload}, default=str, ensure_ascii=False)
        dead: list[WebSocket] = []
        for websocket in list(self.active_connections):
            try:
                await websocket.send_text(message)
            except (RuntimeError, WebSocketDisconnect):
                dead.append(websocket)
        for websocket in dead:
            self._remove(websocket)
        if dead:
            await self.broadcast_peer_lists()


manager = ConnectionManager()
