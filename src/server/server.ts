import {
  ClientMsg,
  ClientStateUpdate,
  FireEvent,
  PICKUP_SPAWNS,
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
import {
  createPlayer,
  aimTargetPoint,
  directionTo,
  muzzlePosition,
  pointOnRay,
  raycastLevel,
  raycastPlayers,
  resetPlayer,
} from "../shared/physics.ts";
import { SETTINGS } from "../shared/settings.ts";

const HOST = Deno.env.get("HOST") ?? "0.0.0.0";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const SNAPSHOT_EVERY = Math.floor(TICK_RATE / SNAPSHOOT_RATE);
const RESPAWN_TICKS = Math.floor(SETTINGS.combat.respawnMs / TICK_DT);
const FIRE_MAX_DIST = SETTINGS.combat.fireMaxDistance;
const SERVER_STARTED_AT = new Date().toISOString();

interface Client {
  id: string;
  socket: WebSocket;
  state: PlayerState;
  spawnIndex: number;
}

const clients = new Map<string, Client>();
const pickups: PickupState[] = PICKUP_SPAWNS.map((spawn) => ({
  ...spawn,
  pos: { ...spawn.pos },
  active: true,
  respawnAtTick: 0,
}));
let serverTick = 0;

function clientLabel(client: Client): string {
  return `${client.state.name} (${client.id.slice(0, 8)})`;
}

function sanitizeName(value: string | null): string {
  const name = (value ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  return name || "Player";
}

function isNameTaken(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return [...clients.values()].some(
    (client) => client.state.name.toLocaleLowerCase() === normalized,
  );
}

function broadcast(msg: ServerMsg, except?: string) {
  const data = JSON.stringify(msg);
  for (const [id, client] of clients) {
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

function allPlayerStates(): PlayerState[] {
  return [...clients.values()].map((client) => client.state);
}

function pickupRespawnTicks(pickup: PickupState): number {
  return Math.ceil((pickup.respawnMs / 1000) * TICK_RATE);
}

function applyPickup(client: Client, pickup: PickupState) {
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

function updatePickups() {
  for (const pickup of pickups) {
    if (!pickup.active && serverTick >= pickup.respawnAtTick) {
      pickup.active = true;
    }
  }

  for (const client of clients.values()) {
    const p = client.state;
    if (p.dead) continue;
    for (const pickup of pickups) {
      if (!pickup.active) continue;
      const dist = Math.hypot(
        p.pos.x - pickup.pos.x,
        p.pos.y + 0.8 - pickup.pos.y,
        p.pos.z - pickup.pos.z,
      );
      if (dist < 1.55) applyPickup(client, pickup);
    }
  }
}

function applyClientState(client: Client, update: ClientStateUpdate) {
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
    }
  }

  if (update.reload) {
    p.ammo = getWeapon(p.weaponId).maxAmmo;
  }

  if (update.fire) {
    const event = tryFire(client, serverTick);
    if (event) broadcast({ type: "fire", event });
  }
}

function tryFire(client: Client, tick: number): FireEvent | null {
  const p = client.state;
  if (p.dead || p.ammo <= 0) return null;

  const weapon = getWeapon(p.weaponId);
  const cooldownTicks = Math.max(1, Math.ceil((weapon.cooldownMs / 1000) * TICK_RATE));
  if (tick - p.lastFireTick < cooldownTicks) return null;

  p.lastFireTick = tick;
  p.ammo--;

  const origin = muzzlePosition(p);
  const aimPoint = aimTargetPoint(p, FIRE_MAX_DIST, allPlayerStates());
  const dir = directionTo(origin, aimPoint);
  const levelHit = raycastLevel(origin, dir, FIRE_MAX_DIST);
  const playerHit = raycastPlayers(origin, dir, FIRE_MAX_DIST, p.id, allPlayerStates());

  let hitPlayerId: string | undefined;
  let hitPos: { x: number; y: number; z: number } | undefined;

  if (playerHit && (levelHit === null || playerHit.t < levelHit)) {
    hitPlayerId = playerHit.player.id;
    hitPos = pointOnRay(origin, dir, playerHit.t);

    const victim = playerHit.player;
    victim.hp -= weapon.damage;
    broadcast({ type: "hit", victimId: victim.id, damage: weapon.damage, hp: victim.hp });

    if (victim.hp <= 0 && !victim.dead) {
      victim.dead = true;
      victim.respawnTick = tick + RESPAWN_TICKS;
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

function gameLoop() {
  serverTick++;

  for (const client of clients.values()) {
    if (client.state.dead && serverTick >= client.state.respawnTick) {
      resetPlayer(client.state, client.spawnIndex);
    }
  }

  updatePickups();

  if (serverTick % SNAPSHOT_EVERY === 0) {
    const snapshot: Snapshot = {
      tick: serverTick,
      serverTime: performance.now(),
      players: [...clients.values()].map((client) => clonePlayerState(client.state)),
      pickups: pickups.map((pickup) => ({ ...pickup, pos: { ...pickup.pos } })),
    };
    broadcast({ type: "snapshot", snapshot });
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
    }
  } catch {
    // Ignore malformed messages
  }
}

function removeClient(id: string) {
  const client = clients.get(id);
  if (client) console.log(`[disconnect] ${clientLabel(client)}`);
  clients.delete(id);
}

Deno.serve({ hostname: HOST, port: PORT }, (req) => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const id = crypto.randomUUID();
    const spawnIndex = clients.size;
    const state = createPlayer(id, spawnIndex);
    state.name = sanitizeName(new URL(req.url).searchParams.get("name"));
    if (isNameTaken(state.name)) {
      socket.onopen = () => socket.close(4000, "Name already in use");
      return response;
    }

    const client: Client = { id, socket, state, spawnIndex };
    clients.set(id, client);

    socket.onopen = () => {
      console.log(`[connect] ${clientLabel(client)}`);
      send(client, { type: "welcome", id, tick: serverTick });
    };
    socket.onmessage = (event) => handleClientMessage(client, event.data);
    socket.onclose = () => removeClient(id);
    socket.onerror = () => removeClient(id);

    return response;
  }

  const url = new URL(req.url);
  let path = url.pathname;
  if (path === "/health") {
    return Response.json(
      { startedAt: SERVER_STARTED_AT },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  }

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
