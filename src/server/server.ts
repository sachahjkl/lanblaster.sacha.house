import {
  Balloon,
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
  TrainingTarget,
  Vec3,
  WEAPONS,
  clonePlayerState,
  getWeapon,
} from "../shared/protocol.ts";
import { DEFAULT_LEVEL_ID, LevelDefinition, getLevelData } from "../shared/mapData.ts";
import {
  createPlayer,
  applySpread,
  currentSpreadForPlayer,
  lookDirection,
  muzzlePosition,
  pointOnRay,
  raycastBalloon,
  raycastLevel,
  raycastPlayers,
  raycastTrainingTarget,
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
  levelId: string;
  level: LevelDefinition;
  password: string | undefined;
  hostId: string;
  maxPlayers: number;
  clients: Map<string, Client>;
  pickups: PickupState[];
  balloons: Balloon[];
  emptySince: number | undefined;
}

const rooms = new Map<string, Room>();
let serverTick = 0;

function makePickups(level: LevelDefinition): PickupState[] {
  return level.pickupSpawns.map((spawn) => ({
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

function emitRoomEvent(room: Room, text: string) {
  console.log(`[room:${room.name}] ${text}`);
  broadcast(room, { type: "room_event", text });
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
  if (update.fire) {
    const events = tryFire(room, client, serverTick);
    for (const event of events) broadcast(room, { type: "fire", event });
  }

  p.spreadAccumMs = updateSpreadAccum(weapon, p.spreadAccumMs, dtTicks * TICK_DT, update.fire);
}

function firePellet(
  room: Room,
  p: PlayerState,
  weapon: (typeof WEAPONS)[number],
  tick: number,
): FireEvent {
  const spread = currentSpreadForPlayer(p, weapon, p.spreadAccumMs);
  const origin = muzzlePosition(p, spread);
  const dir = applySpread(lookDirection(p), spread);
  const levelHit = raycastLevel(origin, dir, FIRE_MAX_DIST, room.level);
  const playerHit = raycastPlayers(origin, dir, FIRE_MAX_DIST, p.id, allPlayerStates(room));

  let bestTargetHit: {
    target: TrainingTarget;
    t: number;
    point: Vec3;
    ring: number;
  } | null = null;
  for (const target of room.level.trainingTargets) {
    const hit = raycastTrainingTarget(origin, dir, FIRE_MAX_DIST, target);
    if (hit && (!bestTargetHit || hit.t < bestTargetHit.t)) {
      bestTargetHit = { target, ...hit };
    }
  }

  let bestBalloonHit: { balloon: Balloon; t: number; point: Vec3 } | null = null;
  for (const balloon of room.balloons) {
    if (!balloon.active) continue;
    const hit = raycastBalloon(origin, dir, FIRE_MAX_DIST, balloon);
    if (hit && (!bestBalloonHit || hit.t < bestBalloonHit.t)) {
      bestBalloonHit = { balloon, ...hit };
    }
  }

  let closestT = Infinity;
  let hitType: "player" | "target" | "balloon" | "level" | null = null;
  let hitData: unknown = null;

  if (playerHit && playerHit.t < closestT && (levelHit === null || playerHit.t < levelHit)) {
    closestT = playerHit.t;
    hitType = "player";
    hitData = playerHit;
  }
  if (
    bestTargetHit &&
    bestTargetHit.t < closestT &&
    (levelHit === null || bestTargetHit.t < levelHit)
  ) {
    closestT = bestTargetHit.t;
    hitType = "target";
    hitData = bestTargetHit;
  }
  if (
    bestBalloonHit &&
    bestBalloonHit.t < closestT &&
    (levelHit === null || bestBalloonHit.t < levelHit)
  ) {
    closestT = bestBalloonHit.t;
    hitType = "balloon";
    hitData = bestBalloonHit;
  }
  if (levelHit !== null && levelHit < closestT) {
    closestT = levelHit;
    hitType = "level";
  }

  let hitPlayerId: string | undefined;
  let hitPos: Vec3 | undefined;

  if (hitType === "player") {
    const { player: victim, t } = hitData as { t: number; player: PlayerState };
    const point = pointOnRay(origin, dir, t);
    hitPlayerId = victim.id;
    hitPos = point;
    const dist = Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z);
    const damage = Math.max(
      1,
      Math.round(weapon.damage * playerDistanceDamageMultiplier(dist, weapon)),
    );
    victim.hp -= damage;
    broadcast(room, {
      type: "hit",
      victimId: victim.id,
      shooterId: p.id,
      damage,
      hp: victim.hp,
      pos: point,
    });

    if (victim.hp <= 0 && !victim.dead) {
      victim.dead = true;
      victim.respawnTick = tick + RESPAWN_TICKS;
      victim.deaths++;
      p.kills++;
      p.score = p.kills - p.deaths;
      victim.score = victim.kills - victim.deaths;
      console.log(`[death] ${victim.name} killed by ${p.name} with ${weapon.name}`);
      broadcast(room, {
        type: "death",
        victimId: victim.id,
        killerId: p.id,
        weaponId: weapon.id,
      });
      emitRoomEvent(room, `${victim.name} was fragged by ${p.name} (${weapon.name})`);
    }
  } else if (hitType === "target") {
    const { target, point, ring } = hitData as {
      target: TrainingTarget;
      t: number;
      point: Vec3;
      ring: number;
    };
    hitPos = point;
    const dist = Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z);
    const damage = Math.max(
      1,
      Math.round(weapon.damage * target.ringDamage[ring] * targetDistanceDamageMultiplier(dist)),
    );
    broadcast(room, {
      type: "hit",
      victimId: target.id,
      shooterId: p.id,
      damage,
      hp: 0,
      pos: point,
      crit: ring === 0,
    });
  } else if (hitType === "balloon") {
    const { balloon, point } = hitData as { balloon: Balloon; t: number; point: Vec3 };
    hitPos = point;
    balloon.active = false;
    broadcast(room, {
      type: "hit",
      victimId: balloon.id,
      shooterId: p.id,
      damage: 25,
      hp: 0,
      pos: point,
      crit: true,
    });
  } else if (hitType === "level") {
    hitPos = pointOnRay(origin, dir, levelHit as number);
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
    levelId: room.levelId,
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
    emitRoomEvent(room, `${client.state.name} left the room`);
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
  levelId: string | undefined,
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
  const level = getLevelData(levelId ?? DEFAULT_LEVEL_ID);
  const id = crypto.randomUUID();
  const room: Room = {
    id,
    name: sanitizeRoomName(name ?? null) || `Room ${rooms.size + 1}`,
    levelId: level.id,
    level,
    password: password && password.length > 0 ? password : undefined,
    hostId: "",
    maxPlayers: safeMax,
    clients: new Map(),
    pickups: makePickups(level),
    balloons: [],
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
  emitRoomEvent(room, `${client.state.name} joined the room`);
  return { ok: true };
}

function handleRespawnRequest(client: Client) {
  const room = rooms.get(client.roomId);
  if (!room || !client.state.dead) return;
  resetPlayer(client.state, room.level, client.spawnIndex);
  emitRoomEvent(room, `${client.state.name} respawned`);
}

function spawnBalloons(room: Room) {
  if (room.level.balloonSpawns.length === 0) return;
  for (let i = 0; i < room.level.balloonSpawns.length; i++) {
    const spawn = room.level.balloonSpawns[i];
    room.balloons.push({
      id: `balloon-${serverTick}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      pos: {
        x: spawn.x + (Math.random() - 0.5) * 16,
        y: spawn.y,
        z: spawn.z + (Math.random() - 0.5) * 16,
      },
      radius: 0.4,
      active: true,
    });
  }
  emitRoomEvent(room, "Balloons released");
}

function updateBalloons(room: Room) {
  for (const balloon of room.balloons) {
    if (!balloon.active) continue;
    balloon.pos.y += 0.012;
    balloon.pos.x += Math.sin(serverTick * 0.02 + balloon.pos.y) * 0.002;
    if (balloon.pos.y > 16) balloon.active = false;
  }
  // Prune popped/floated-away balloons to keep snapshot small.
  if (room.balloons.length > 64) {
    room.balloons = room.balloons.filter((b) => b.active);
  }
}

function handleSpawnBalloons(client: Client) {
  const room = rooms.get(client.roomId);
  if (!room) return;
  spawnBalloons(room);
}

function sanitizeChat(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 128);
}

function targetDistanceDamageMultiplier(distance: number): number {
  return Math.min(2.5, 1 + distance / 150);
}

function playerDistanceDamageMultiplier(distance: number, weapon: WeaponConfig): number {
  if (!weapon.damageFalloffEnd) return 1;
  const start = weapon.damageFalloffStart ?? 0;
  if (distance <= start) return 1;
  const end = weapon.damageFalloffEnd;
  const min = weapon.damageFalloffMin ?? 0.5;
  if (distance >= end) return min;
  return 1 - ((distance - start) / (end - start)) * (1 - min);
}

function handleChat(client: Client, msg: Extract<ClientMsg, { type: "chat" }>) {
  const room = rooms.get(client.roomId);
  if (!room || client.state.dead) return;
  const text = sanitizeChat(msg.text);
  if (!text) return;
  emitRoomEvent(room, `${client.state.name}: ${text}`);
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
        resetPlayer(client.state, room.level, client.spawnIndex);
        emitRoomEvent(room, `${client.state.name} auto-respawned`);
      }
      if (client.state.reloadEndTick > 0 && serverTick >= client.state.reloadEndTick) {
        client.state.ammo = getWeapon(client.state.weaponId).maxAmmo;
        client.state.reloadEndTick = 0;
      }
    }

    updatePickups(room);
    updateBalloons(room);

    if (serverTick % SNAPSHOT_EVERY === 0) {
      const snapshot: Snapshot = {
        tick: serverTick,
        serverTime: performance.now(),
        players: [...room.clients.values()].map((client) => clonePlayerState(client.state)),
        pickups: room.pickups.map((pickup) => ({ ...pickup, pos: { ...pickup.pos } })),
        balloons: room.balloons.map((balloon) => ({ ...balloon, pos: { ...balloon.pos } })),
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
    } else if (msg.type === "respawn") {
      handleRespawnRequest(client);
    } else if (msg.type === "chat") {
      handleChat(client, msg);
    } else if (msg.type === "spawn_balloons") {
      handleSpawnBalloons(client);
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
      levelId: room.levelId,
      levelName: room.level.name,
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
    const desiredLevelId = url.searchParams.get("levelId");

    const client: Client = {
      id,
      socket,
      state: createPlayer(id),
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
      const created = createRoom(
        desiredRoomName ?? undefined,
        desiredLevelId ?? undefined,
        password ?? undefined,
        desiredMax,
      );
      if ("error" in created) {
        socket.onopen = () => {
          send(client, { type: "error", message: created.error });
          socket.close(4002, created.error);
        };
        return response;
      }
      room = created;
      console.log(
        `[room] ${clientLabel(client)} created "${room.name}" [${room.level.name}] (${room.id}) max=${room.maxPlayers}`,
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
    resetPlayer(client.state, room.level, client.spawnIndex);
    client.state.name = name;

    socket.onopen = () => {
      send(client, {
        type: "welcome",
        id,
        tick: serverTick,
        roomId: room!.id,
        roomName: room!.name,
        levelId: room!.levelId,
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
