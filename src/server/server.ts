import {
  ClientMsg,
  ClientStateUpdate,
  FireEvent,
  PickupState,
  PlayerState,
  ServerMsg,
  Snapshot,
  SNAPSHOOT_RATE,
  TICK_DT,
  TICK_RATE,
  WEAPONS,
  clonePlayerState,
  getWeapon,
} from "../shared/protocol.ts";
import { PICKUP_SPAWNS } from "../shared/mapData.ts";
import {
  createPlayer,
  aimTargetPoint,
  applySpread,
  currentSpread,
  directionTo,
  muzzlePosition,
  pointOnRay,
  raycastLevel,
  raycastPlayers,
  resetPlayer,
  updateSpreadAccum,
} from "../shared/physics.ts";
import { SETTINGS } from "../shared/settings.ts";

const HOST = Deno.env.get("HOST") ?? "0.0.0.0";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const SNAPSHOT_EVERY = Math.floor(TICK_RATE / SNAPSHOOT_RATE);
const RESPAWN_TICKS = Math.floor(SETTINGS.combat.respawnMs / TICK_DT);
const FIRE_MAX_DIST = SETTINGS.combat.fireMaxDistance;
const SERVER_STARTED_AT = new Date().toISOString();

const MAX_ROOMS = 64;
const MAX_LARGE_ROOMS = 16;
const DEFAULT_MAX_PLAYERS = 16;
const DANGER_MAX_PLAYERS = 32;
const ROOM_EMPTY_TTL_MS = 5 * 60 * 1000;

interface Client {
  id: string;
  socket: WebSocket;
  state: PlayerState;
  spawnIndex: number;
  roomId: string;
}

interface Room {
  id: string;
  name: string;
  password: string | undefined;
  hostId: string;
  maxPlayers: number;
  clients: Map<string, Client>;
  pickups: PickupState[];
  emptySince: number | undefined;
}

const rooms = new Map<string, Room>();
let serverTick = 0;

function makePickups(): PickupState[] {
  return PICKUP_SPAWNS.map((spawn) => ({
    ...spawn,
    pos: { ...spawn.pos },
    active: true,
    respawnAtTick: 0,
  }));
}

function clientLabel(client: Client): string {
  return `${client.state.name} (${client.id.slice(0, 8)})`;
}

function sanitizeName(value: string | null): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  return name || "Player";
}

function sanitizeRoomName(value: string | null): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  return name || "Arena";
}

function isNameTaken(room: Room, name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return [...room.clients.values()].some(
    (client) => client.state.name.toLocaleLowerCase() === normalized,
  );
}

function broadcast(room: Room, msg: ServerMsg, except?: string) {
  const data = JSON.stringify(msg);
  for (const [id, client] of room.clients) {
    if (id !== except && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(data);
    }
  }
}

function send(client: Client, msg: ServerMsg) {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(msg));
  }
}

function allPlayerStates(room: Room): PlayerState[] {
  return [...room.clients.values()].map((client) => client.state);
}

function pickupRespawnTicks(pickup: PickupState): number {
  return Math.ceil((pickup.respawnMs / 1000) * TICK_RATE);
}

function applyPickup(room: Room, client: Client, pickup: PickupState) {
  const p = client.state;
  if (pickup.type === "ammo") {
    p.ammo = getWeapon(p.weaponId).maxAmmo;
  } else if (pickup.weaponId) {
    const weapon = getWeapon(pickup.weaponId);
    p.weaponId = weapon.id;
    p.ammo = weapon.maxAmmo;
  }

  pickup.active = false;
  pickup.respawnAtTick = serverTick + pickupRespawnTicks(pickup);
  send(client, { type: "pickup", label: pickup.label ?? pickup.weaponId?.toUpperCase() ?? "AMMO" });
  console.log(`[pickup] ${clientLabel(client)} took ${pickup.type}:${pickup.weaponId ?? "ammo"}`);
}

function updatePickups(room: Room) {
  for (const pickup of room.pickups) {
    if (!pickup.active && serverTick >= pickup.respawnAtTick) {
      pickup.active = true;
    }
  }

  for (const client of room.clients.values()) {
    const p = client.state;
    if (p.dead) continue;
    for (const pickup of room.pickups) {
      if (!pickup.active) continue;
      const dist = Math.hypot(
        p.pos.x - pickup.pos.x,
        p.pos.y + 0.8 - pickup.pos.y,
        p.pos.z - pickup.pos.z,
      );
      if (dist < 1.55) applyPickup(room, client, pickup);
    }
  }
}

function applyClientState(client: Client, update: ClientStateUpdate) {
  const room = rooms.get(client.roomId);
  if (!room) return;
  const p = client.state;
  p.lastProcessedInputSeq = Math.max(p.lastProcessedInputSeq, update.seq);

  if (!p.dead) {
    p.pos = { ...update.pos };
    p.vel = { ...update.vel };
    p.yaw = update.yaw;
    p.pitch = update.pitch;
    p.grounded = update.grounded;
    p.crouching = update.crouching;
    p.aiming = update.aiming;
    p.jumpPadSeq = update.jumpPadSeq;
  }

  if (update.weaponIndex >= 0 && update.weaponIndex < WEAPONS.length) {
    const weapon = WEAPONS[update.weaponIndex];
    if (weapon.id !== p.weaponId) {
      p.weaponId = weapon.id;
      p.ammo = weapon.maxAmmo;
      p.spreadAccumMs = 0;
      p.reloadEndTick = 0;
    }
  }

  const weapon = getWeapon(p.weaponId);
  const reloadDurationTicks = Math.max(1, Math.ceil((weapon.reloadMs / 1000) * TICK_RATE));

  if (p.reloadEndTick > 0 && serverTick >= p.reloadEndTick) {
    p.ammo = weapon.maxAmmo;
    p.reloadEndTick = 0;
  }
  if (update.reload && p.reloadEndTick === 0 && p.ammo < weapon.maxAmmo) {
    p.reloadEndTick = serverTick + reloadDurationTicks;
  }

  const dtTicks = Math.max(0, serverTick - p.lastSpreadUpdateTick);
  p.lastSpreadUpdateTick = serverTick;
  p.spreadAccumMs = updateSpreadAccum(weapon, p.spreadAccumMs, dtTicks * TICK_DT, update.fire);

  if (update.fire) {
    const events = tryFire(room, client, serverTick);
    for (const event of events) broadcast(room, { type: "fire", event });
  }
}

function firePellet(
  room: Room,
  p: PlayerState,
  weapon: (typeof WEAPONS)[number],
  tick: number,
): FireEvent {
  const spread = currentSpread(weapon, p.spreadAccumMs);
  const origin = muzzlePosition(p, spread);
  const aimPoint = aimTargetPoint(p, FIRE_MAX_DIST, allPlayerStates(room));
  const dir = applySpread(directionTo(origin, aimPoint), spread);
  const levelHit = raycastLevel(origin, dir, FIRE_MAX_DIST);
  const playerHit = raycastPlayers(origin, dir, FIRE_MAX_DIST, p.id, allPlayerStates(room));

  let hitPlayerId: string | undefined;
  let hitPos: { x: number; y: number; z: number } | undefined;

  if (playerHit && (levelHit === null || playerHit.t < levelHit)) {
    hitPlayerId = playerHit.player.id;
    hitPos = pointOnRay(origin, dir, playerHit.t);

    const victim = playerHit.player;
    victim.hp -= weapon.damage;
    broadcast(room, { type: "hit", victimId: victim.id, damage: weapon.damage, hp: victim.hp });

    if (victim.hp <= 0 && !victim.dead) {
      victim.dead = true;
      victim.respawnTick = tick + RESPAWN_TICKS;
      victim.deaths++;
      p.kills++;
      p.score = p.kills - p.deaths;
      victim.score = victim.kills - victim.deaths;
      console.log(`[death] ${victim.name} killed by ${p.name} with ${weapon.name}`);
    }
  } else if (levelHit !== null) {
    hitPos = pointOnRay(origin, dir, levelHit);
  }

  return {
    tick,
    shooterId: p.id,
    origin,
    direction: dir,
    weaponId: weapon.id,
    hitPlayerId,
    hitPos,
  };
}

function tryFire(room: Room, client: Client, tick: number): FireEvent[] {
  const p = client.state;
  if (p.dead || p.ammo <= 0 || p.reloadEndTick > tick) return [];

  const weapon = getWeapon(p.weaponId);
  const cooldownTicks = Math.max(1, Math.ceil((weapon.cooldownMs / 1000) * TICK_RATE));
  if (tick - p.lastFireTick < cooldownTicks) return [];

  p.lastFireTick = tick;
  p.ammo--;

  const pellets = weapon.pelletCount ?? 1;
  const events: FireEvent[] = [];
  for (let i = 0; i < pellets; i++) {
    events.push(firePellet(room, p, weapon, tick));
  }
  return events;
}

function broadcastRoomInfo(room: Room) {
  const msg: ServerMsg = {
    type: "room_info",
    roomId: room.id,
    name: room.name,
    hasPassword: !!room.password,
    hostId: room.hostId,
  };
  broadcast(room, msg);
}

function chooseSpawnIndex(room: Room): number {
  const used = new Set([...room.clients.values()].map((c) => c.spawnIndex));
  for (let i = 0; i < 1000; i++) {
    if (!used.has(i)) return i;
  }
  return 0;
}

function electHost(room: Room) {
  const next = room.clients.values().next().value as Client | undefined;
  room.hostId = next?.id ?? "";
  if (next) broadcastRoomInfo(room);
}

function removeClient(id: string) {
  for (const room of rooms.values()) {
    const client = room.clients.get(id);
    if (!client) continue;
    room.clients.delete(id);
    console.log(
      `[leave] ${clientLabel(client)} left room "${room.name}" (${room.clients.size}/${room.maxPlayers} remaining)`,
    );
    if (room.clients.size === 0) {
      room.emptySince = Date.now();
    } else if (room.hostId === id) {
      electHost(room);
    }
    return;
  }
}

function createRoom(
  name: string | undefined,
  password: string | undefined,
  maxPlayers: number,
): Room | { error: string } {
  if (rooms.size >= MAX_ROOMS) {
    return { error: "Server room limit reached" };
  }
  const safeMax = Math.max(DEFAULT_MAX_PLAYERS, Math.min(DANGER_MAX_PLAYERS, maxPlayers));
  if (safeMax === DANGER_MAX_PLAYERS) {
    const largeCount = [...rooms.values()].filter(
      (r) => r.maxPlayers === DANGER_MAX_PLAYERS,
    ).length;
    if (largeCount >= MAX_LARGE_ROOMS) {
      return { error: "Maximum number of 32-player rooms reached" };
    }
  }
  const id = crypto.randomUUID();
  const room: Room = {
    id,
    name: sanitizeRoomName(name ?? null) || `Room ${rooms.size + 1}`,
    password: password && password.length > 0 ? password : undefined,
    hostId: "",
    maxPlayers: safeMax,
    clients: new Map(),
    pickups: makePickups(),
    emptySince: undefined,
  };
  rooms.set(id, room);
  return room;
}

function joinRoom(
  room: Room,
  password: string | null,
  client: Client,
): { ok: true } | { error: string } {
  if (room.clients.size >= room.maxPlayers) {
    return { error: "Room is full" };
  }
  if (room.password && room.password !== (password ?? "")) {
    return { error: "Incorrect password" };
  }
  if (isNameTaken(room, client.state.name)) {
    return { error: "Name already in use in this room" };
  }
  room.clients.set(client.id, client);
  room.emptySince = undefined;
  if (room.clients.size === 1) {
    room.hostId = client.id;
  }
  console.log(
    `[join] ${clientLabel(client)} joined "${room.name}" (${room.clients.size}/${room.maxPlayers})`,
  );
  return { ok: true };
}

function handleRoomUpdate(client: Client, msg: Extract<ClientMsg, { type: "room_update" }>) {
  const room = rooms.get(client.roomId);
  if (!room || room.hostId !== client.id) return;
  if (msg.name !== undefined) {
    room.name = sanitizeRoomName(msg.name);
  }
  if (msg.password !== undefined) {
    room.password = msg.password && msg.password.length > 0 ? msg.password : undefined;
  }
  if (msg.maxPlayers !== undefined) {
    const desired = Math.max(DEFAULT_MAX_PLAYERS, Math.min(DANGER_MAX_PLAYERS, msg.maxPlayers));
    if (desired === DANGER_MAX_PLAYERS) {
      const largeCount = [...rooms.values()].filter(
        (r) => r.maxPlayers === DANGER_MAX_PLAYERS,
      ).length;
      if (largeCount >= MAX_LARGE_ROOMS && room.maxPlayers !== DANGER_MAX_PLAYERS) {
        // Don't change if it would exceed limit.
      } else {
        room.maxPlayers = desired;
      }
    } else {
      room.maxPlayers = desired;
    }
  }
  broadcastRoomInfo(room);
}

function gameLoop() {
  serverTick++;

  for (const room of rooms.values()) {
    if (room.emptySince && Date.now() - room.emptySince > ROOM_EMPTY_TTL_MS) {
      console.log(`[room] expired ${room.name} (${room.id})`);
      rooms.delete(room.id);
      continue;
    }

    for (const client of room.clients.values()) {
      if (client.state.dead && serverTick >= client.state.respawnTick) {
        resetPlayer(client.state, client.spawnIndex);
      }
      if (client.state.reloadEndTick > 0 && serverTick >= client.state.reloadEndTick) {
        client.state.ammo = getWeapon(client.state.weaponId).maxAmmo;
        client.state.reloadEndTick = 0;
      }
    }

    updatePickups(room);

    if (serverTick % SNAPSHOT_EVERY === 0) {
      const snapshot: Snapshot = {
        tick: serverTick,
        serverTime: performance.now(),
        players: [...room.clients.values()].map((client) => clonePlayerState(client.state)),
        pickups: room.pickups.map((pickup) => ({ ...pickup, pos: { ...pickup.pos } })),
      };
      broadcast(room, { type: "snapshot", snapshot });
    }
  }
}

function handleClientMessage(client: Client, data: string) {
  try {
    const msg = JSON.parse(data) as ClientMsg;
    if (msg.type === "state") {
      applyClientState(client, msg.state);
    } else if (msg.type === "ping") {
      send(client, {
        type: "pong",
        clientTime: msg.clientTime,
        serverTime: performance.now(),
      });
    } else if (msg.type === "room_update") {
      handleRoomUpdate(client, msg);
    }
  } catch {
    // Ignore malformed messages
  }
}

Deno.serve({ hostname: HOST, port: PORT }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/rooms") {
    const list = [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      playerCount: room.clients.size,
      maxPlayers: room.maxPlayers,
      hasPassword: !!room.password,
    }));
    return Response.json(list, { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/health") {
    return Response.json(
      { startedAt: SERVER_STARTED_AT },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const id = crypto.randomUUID();
    const name = sanitizeName(url.searchParams.get("name"));
    const roomId = url.searchParams.get("room");
    const password = url.searchParams.get("password");
    const desiredMax = Number(url.searchParams.get("maxPlayers") ?? DEFAULT_MAX_PLAYERS);
    const desiredRoomName = url.searchParams.get("roomName");

    const client: Client = {
      id,
      socket,
      state: createPlayer(id, 0),
      spawnIndex: 0,
      roomId: "",
    };
    client.state.name = name;

    let room: Room | undefined;
    if (roomId) {
      room = rooms.get(roomId);
      if (!room) {
        socket.onopen = () => {
          send(client, { type: "error", message: "Room not found" });
          socket.close(4001, "Room not found");
        };
        return response;
      }
    } else {
      const created = createRoom(desiredRoomName ?? undefined, password ?? undefined, desiredMax);
      if ("error" in created) {
        socket.onopen = () => {
          send(client, { type: "error", message: created.error });
          socket.close(4002, created.error);
        };
        return response;
      }
      room = created;
      console.log(
        `[room] ${clientLabel(client)} created "${room.name}" (${room.id}) max=${room.maxPlayers}`,
      );
    }

    if (!room) {
      socket.onopen = () => socket.close(4003, "Could not join room");
      return response;
    }

    const joined = joinRoom(room, password, client);
    if ("error" in joined) {
      socket.onopen = () => {
        send(client, { type: "error", message: joined.error });
        socket.close(4004, joined.error);
      };
      return response;
    }

    client.roomId = room.id;
    client.spawnIndex = chooseSpawnIndex(room);
    client.state.pos = { ...client.state.pos }; // ensure fresh pos reference

    socket.onopen = () => {
      send(client, {
        type: "welcome",
        id,
        tick: serverTick,
        roomId: room!.id,
        roomName: room!.name,
        isHost: room!.hostId === id,
      });
      broadcastRoomInfo(room!);
    };
    socket.onmessage = (event) => handleClientMessage(client, event.data);
    socket.onclose = () => removeClient(id);
    socket.onerror = () => removeClient(id);

    return response;
  }

  let path = url.pathname;
  if (path === "/") path = "/index.html";
  path = decodeURIComponent(path);

  return Deno.readFile(`./dist/client${path}`)
    .then((file) => {
      const contentType = path.endsWith(".html")
        ? "text/html"
        : path.endsWith(".js")
          ? "application/javascript"
          : path.endsWith(".css")
            ? "text/css"
            : "application/octet-stream";
      return new Response(file, { headers: { "content-type": contentType } });
    })
    .catch(() => new Response("Not found", { status: 404 }));
});

setInterval(gameLoop, TICK_DT);

console.log(`Server running on http://${HOST}:${PORT}`);
console.log(`LAN URL usually: http://<your-computer-hostname>:${PORT}`);
