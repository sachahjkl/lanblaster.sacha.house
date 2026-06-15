// Shared game protocol and constants used by client and server.
import { SETTINGS } from "./settings.ts";

export const TICK_RATE = SETTINGS.net.tickRate; // Hz
export const TICK_DT = 1000 / TICK_RATE; // ms
export const SNAPSHOOT_RATE = SETTINGS.net.snapshotRate; // Hz (server sends world snapshots)
export const PLAYER_SPEED = SETTINGS.player.speed;
export const JUMP_SPEED = SETTINGS.player.jumpSpeed;
export const GRAVITY = SETTINGS.player.gravity;
export const PLAYER_RADIUS = SETTINGS.player.radius;
export const PLAYER_HEIGHT = SETTINGS.player.height;
export const PLAYER_CROUCH_HEIGHT = SETTINGS.player.crouchHeight;
export const GROUND_FRICTION = SETTINGS.player.groundFriction;
export const AIR_FRICTION = SETTINGS.player.airFriction;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WeaponConfig {
  id: string;
  name: string;
  damage: number;
  cooldownMs: number;
  maxAmmo: number;
  reloadMs: number;
  projectileSpeed?: number; // optional; undefined = hitscan
}

export const WEAPONS: WeaponConfig[] = [
  { id: "pistol", name: "Pistol", damage: 25, cooldownMs: 300, maxAmmo: 12, reloadMs: 1000 },
  { id: "rifle", name: "Rifle", damage: 18, cooldownMs: 100, maxAmmo: 30, reloadMs: 1500 },
  { id: "sniper", name: "Sniper", damage: 80, cooldownMs: 1200, maxAmmo: 5, reloadMs: 2000 },
];

export function getWeapon(id: string): WeaponConfig {
  return WEAPONS.find((w) => w.id === id) ?? WEAPONS[0];
}

export interface PlayerInput {
  seq: number;
  forward: number; // -1..1
  right: number; // -1..1
  jump: boolean;
  crouch: boolean;
  aiming: boolean;
  fire: boolean;
  reload: boolean;
  weaponIndex: number;
  lookYaw: number; // radians
  lookPitch: number; // radians
}

export interface PlayerState {
  id: string;
  name: string;
  pos: Vec3;
  vel: Vec3;
  platformVel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  aiming: boolean;
  jumpPadSeq: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  respawnTick: number;
  weaponId: string;
  ammo: number;
  lastFireTick: number;
  lastProcessedInputSeq: number;
}

export interface Snapshot {
  tick: number;
  serverTime: number;
  players: PlayerState[];
  pickups: PickupState[];
}

export interface ClientStateUpdate {
  seq: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  aiming: boolean;
  jumpPadSeq: number;
  weaponIndex: number;
  fire: boolean;
  reload: boolean;
}

export interface FireEvent {
  tick: number;
  shooterId: string;
  origin: Vec3;
  direction: Vec3;
  weaponId: string;
  hitPlayerId?: string;
  hitPos?: Vec3;
}

export type ServerMsg =
  | { type: "welcome"; id: string; tick: number }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "fire"; event: FireEvent }
  | { type: "hit"; victimId: string; damage: number; hp: number }
  | { type: "pickup"; label: string }
  | { type: "pong"; clientTime: number; serverTime: number };

export type ClientMsg =
  | { type: "state"; state: ClientStateUpdate }
  | { type: "ping"; clientTime: number };

export interface LevelBox {
  min: Vec3;
  max: Vec3;
  color?: number;
}

export interface JumpPad {
  min: Vec3;
  max: Vec3;
  force: number;
  color?: number;
}

export interface PickupSpawn {
  id: string;
  type: "ammo" | "weapon";
  pos: Vec3;
  label: string;
  weaponId?: string;
  amount?: number;
  respawnMs: number;
}

export interface PickupState extends PickupSpawn {
  active: boolean;
  respawnAtTick: number;
}

export interface MovingPlatform {
  id: string;
  size: Vec3;
  from: Vec3;
  to: Vec3;
  periodMs: number;
  color?: number;
}

export interface LadderZone {
  id: string;
  min: Vec3;
  max: Vec3;
}

export interface Decoration {
  id: string;
  kind: "light" | "crate" | "obelisk" | "antenna";
  pos: Vec3;
  yaw?: number;
  color?: number;
}

function pushBox(boxes: LevelBox[], min: Vec3, max: Vec3, color: number): void {
  boxes.push({ min, max, color });
}

function pushStairs(
  boxes: LevelBox[],
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  steps: number,
  width: number,
  stepDepth: number,
  stepHeight: number,
  color: number,
): void {
  for (let i = 0; i < steps; i++) {
    const cx = x + dirX * stepDepth * (i + 0.5);
    const cz = z + dirZ * stepDepth * (i + 0.5);
    const sx = dirX === 0 ? width : stepDepth;
    const sz = dirZ === 0 ? width : stepDepth;
    pushBox(
      boxes,
      { x: cx - sx * 0.5, y: i * stepHeight, z: cz - sz * 0.5 },
      { x: cx + sx * 0.5, y: (i + 1) * stepHeight, z: cz + sz * 0.5 },
      color,
    );
  }
}

export function generateSymmetricalMap(): LevelBox[] {
  const boxes: LevelBox[] = [];
  const size = 92;
  const half = size / 2;
  const groundY = -2;
  const wallH = 4;

  // Ground
  pushBox(boxes, { x: -half, y: groundY, z: -half }, { x: half, y: 0, z: half }, 0xc9a66b);

  // Outer walls
  const wallThick = 2;
  pushBox(
    boxes,
    { x: -half - wallThick, y: 0, z: -half - wallThick },
    { x: half + wallThick, y: wallH, z: -half },
    0x334455,
  ); // north
  pushBox(
    boxes,
    { x: -half - wallThick, y: 0, z: half },
    { x: half + wallThick, y: wallH, z: half + wallThick },
    0x334455,
  ); // south
  pushBox(
    boxes,
    { x: -half - wallThick, y: 0, z: -half },
    { x: -half, y: wallH, z: half },
    0x334455,
  ); // west
  pushBox(boxes, { x: half, y: 0, z: -half }, { x: half + wallThick, y: wallH, z: half }, 0x334455); // east

  // Three lanes: A (top), B (middle), C (bottom) running east-west
  const laneWidth = 10;
  const laneZ = [-24, 0, 24] as const;

  for (let i = 0; i < 3; i++) {
    const z = laneZ[i];
    const halfW = laneWidth / 2;

    // Lane dividers (walls between lanes) with openings for rotations
    if (i < 2) {
      const dividerZ = z + halfW;
      const gapW = 8;
      pushBox(
        boxes,
        { x: -half + 4, y: 0, z: dividerZ },
        { x: -gapW, y: wallH, z: dividerZ + 1.2 },
        0x445566,
      );
      pushBox(
        boxes,
        { x: gapW, y: 0, z: dividerZ },
        { x: half - 4, y: wallH, z: dividerZ + 1.2 },
        0x445566,
      );
    }
  }

  // Symmetrical cover blocks per lane
  for (const z of laneZ) {
    // Left side cover
    pushBox(boxes, { x: -32, y: 0, z: z - 2.5 }, { x: -27, y: 2.4, z: z + 2.5 }, 0x8c6b42);
    pushBox(boxes, { x: -8, y: 0, z: z - 2 }, { x: -4, y: 2.8, z: z + 2 }, 0x7c5f38);
    // Right side cover (mirrored)
    pushBox(boxes, { x: 27, y: 0, z: z - 2.5 }, { x: 32, y: 2.4, z: z + 2.5 }, 0x8c6b42);
    pushBox(boxes, { x: 4, y: 0, z: z - 2 }, { x: 8, y: 2.8, z: z + 2 }, 0x7c5f38);
  }

  // Base platforms in corners
  pushBox(
    boxes,
    { x: -half + 2, y: 0, z: -half + 2 },
    { x: -half + 12, y: 1.5, z: -half + 12 },
    0x8c4242,
  );
  pushBox(
    boxes,
    { x: half - 12, y: 0, z: half - 12 },
    { x: half - 2, y: 1.5, z: half - 2 },
    0x428c8c,
  );

  // Elevated platforms and towers.
  pushBox(boxes, { x: -8, y: 7, z: -8 }, { x: 8, y: 8, z: 8 }, 0x6b7280);
  pushBox(boxes, { x: -42, y: 0, z: -8 }, { x: -34, y: 11, z: 0 }, 0x475569);
  pushBox(boxes, { x: 34, y: 0, z: 0 }, { x: 42, y: 11, z: 8 }, 0x475569);
  pushBox(boxes, { x: -44, y: 11, z: -10 }, { x: -32, y: 12, z: 2 }, 0x64748b);
  pushBox(boxes, { x: 32, y: 11, z: -2 }, { x: 44, y: 12, z: 10 }, 0x64748b);

  // Deliberate stair routes into vertical play spaces.
  pushStairs(boxes, -18, -11, 1, 0, 7, 5, 2.1, 0.55, 0x64748b);
  pushStairs(boxes, 18, 11, -1, 0, 7, 5, 2.1, 0.55, 0x64748b);
  pushStairs(boxes, -42, 2, 0, -1, 8, 4, 1.65, 0.65, 0x475569);
  pushStairs(boxes, 42, -2, 0, 1, 8, 4, 1.65, 0.65, 0x475569);

  // Extra hiding walls and mid-map sight blockers.
  pushBox(boxes, { x: -2, y: 0, z: -34 }, { x: 2, y: 5, z: -22 }, 0x334155);
  pushBox(boxes, { x: -2, y: 0, z: 22 }, { x: 2, y: 5, z: 34 }, 0x334155);
  pushBox(boxes, { x: -22, y: 0, z: -4 }, { x: -12, y: 4, z: 0 }, 0x475569);
  pushBox(boxes, { x: 12, y: 0, z: 0 }, { x: 22, y: 4, z: 4 }, 0x475569);

  // Crouch-only crawl routes; the low ceiling blocks standing players.
  pushBox(boxes, { x: -45, y: 1.25, z: 12 }, { x: -18, y: 2.25, z: 17 }, 0x1e293b);
  pushBox(boxes, { x: 18, y: 1.25, z: -17 }, { x: 45, y: 2.25, z: -12 }, 0x1e293b);

  return boxes;
}

export const LEVEL: LevelBox[] = generateSymmetricalMap();

export const JUMP_PADS: JumpPad[] = [
  { min: { x: -14, y: 0, z: -14 }, max: { x: -9, y: 0.35, z: -9 }, force: 18, color: 0x38bdf8 },
  { min: { x: 9, y: 0, z: 9 }, max: { x: 14, y: 0.35, z: 14 }, force: 18, color: 0x38bdf8 },
  { min: { x: -33, y: 0, z: -7 }, max: { x: -28, y: 0.35, z: -2 }, force: 24, color: 0xa78bfa },
  { min: { x: 28, y: 0, z: 2 }, max: { x: 33, y: 0.35, z: 7 }, force: 24, color: 0xa78bfa },
];

export const MOVING_PLATFORMS: MovingPlatform[] = [
  {
    id: "north-raid-lift",
    size: { x: 8, y: 0.7, z: 5 },
    from: { x: -38, y: 6.4, z: -2 },
    to: { x: 18, y: 6.4, z: -24 },
    periodMs: 10500,
    color: 0xf97316,
  },
  {
    id: "south-raid-lift",
    size: { x: 8, y: 0.7, z: 5 },
    from: { x: 38, y: 6.4, z: 2 },
    to: { x: -18, y: 6.4, z: 24 },
    periodMs: 11500,
    color: 0x22d3ee,
  },
  {
    id: "mid-vertical-hop",
    size: { x: 6, y: 0.6, z: 6 },
    from: { x: 0, y: 1.2, z: -12 },
    to: { x: 0, y: 7.8, z: -12 },
    periodMs: 6500,
    color: 0xa78bfa,
  },
];

export const LADDERS: LadderZone[] = [
  { id: "west-tower-ladder", min: { x: -34.7, y: 0, z: -0.5 }, max: { x: -33.7, y: 11.5, z: 3.8 } },
  { id: "east-tower-ladder", min: { x: 33.7, y: 0, z: 4.2 }, max: { x: 34.7, y: 11.5, z: 8.5 } },
  { id: "center-ladder-a", min: { x: -9.1, y: 0, z: 5.5 }, max: { x: -8.1, y: 8.2, z: 9.2 } },
  { id: "center-ladder-b", min: { x: 8.1, y: 0, z: -9.2 }, max: { x: 9.1, y: 8.2, z: -5.5 } },
];

export const DECORATIONS: Decoration[] = [
  { id: "lamp-north-a", kind: "light", pos: { x: -24, y: 0, z: -32 }, color: 0x38bdf8 },
  { id: "lamp-north-b", kind: "light", pos: { x: 24, y: 0, z: -32 }, color: 0x38bdf8 },
  { id: "lamp-south-a", kind: "light", pos: { x: -24, y: 0, z: 32 }, color: 0xf97316 },
  { id: "lamp-south-b", kind: "light", pos: { x: 24, y: 0, z: 32 }, color: 0xf97316 },
  { id: "obelisk-mid", kind: "obelisk", pos: { x: 0, y: 8, z: 10 }, color: 0xa78bfa },
  { id: "antenna-west", kind: "antenna", pos: { x: -38, y: 12, z: -4 }, color: 0xfacc15 },
  { id: "antenna-east", kind: "antenna", pos: { x: 38, y: 12, z: 4 }, color: 0xfacc15 },
  { id: "crate-route-a", kind: "crate", pos: { x: -18, y: 0, z: -24 }, yaw: 0.4 },
  { id: "crate-route-b", kind: "crate", pos: { x: 18, y: 0, z: 24 }, yaw: -0.4 },
];

export function movingPlatformPosition(platform: MovingPlatform, timeMs: number): Vec3 {
  const phase = (timeMs % platform.periodMs) / platform.periodMs;
  const t = 0.5 - Math.cos(phase * Math.PI * 2) * 0.5;
  return {
    x: platform.from.x + (platform.to.x - platform.from.x) * t,
    y: platform.from.y + (platform.to.y - platform.from.y) * t,
    z: platform.from.z + (platform.to.z - platform.from.z) * t,
  };
}

export const PICKUP_SPAWNS: PickupSpawn[] = [
  {
    id: "rifle-mid",
    type: "weapon",
    weaponId: "rifle",
    label: "RIFLE",
    pos: { x: 0, y: 8.45, z: 0 },
    respawnMs: 12000,
  },
  {
    id: "sniper-nw",
    type: "weapon",
    weaponId: "sniper",
    label: "SNIPER",
    pos: { x: -38, y: 12.45, z: -4 },
    respawnMs: 18000,
  },
  {
    id: "sniper-se",
    type: "weapon",
    weaponId: "sniper",
    label: "SNIPER",
    pos: { x: 38, y: 12.45, z: 4 },
    respawnMs: 18000,
  },
  {
    id: "ammo-west",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: -22, y: 1.45, z: -24 },
    respawnMs: 8000,
  },
  {
    id: "ammo-east",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: 22, y: 1.45, z: 24 },
    respawnMs: 8000,
  },
  {
    id: "ammo-mid-a",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: -36, y: 1.05, z: 14.5 },
    respawnMs: 8000,
  },
  {
    id: "ammo-mid-b",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: 36, y: 1.05, z: -14.5 },
    respawnMs: 8000,
  },
];

export const SPAWN_POINTS: Vec3[] = [
  { x: -38, y: 4, z: -38 },
  { x: 38, y: 4, z: 38 },
  { x: -38, y: 4, z: 38 },
  { x: 38, y: 4, z: -38 },
  { x: 0, y: 4, z: -30 },
  { x: 0, y: 4, z: 30 },
];

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function clonePlayerState(p: PlayerState): PlayerState {
  return {
    id: p.id,
    name: p.name,
    pos: cloneVec3(p.pos),
    vel: cloneVec3(p.vel),
    platformVel: cloneVec3(p.platformVel),
    yaw: p.yaw,
    pitch: p.pitch,
    grounded: p.grounded,
    crouching: p.crouching,
    aiming: p.aiming,
    jumpPadSeq: p.jumpPadSeq,
    hp: p.hp,
    maxHp: p.maxHp,
    dead: p.dead,
    respawnTick: p.respawnTick,
    weaponId: p.weaponId,
    ammo: p.ammo,
    lastFireTick: p.lastFireTick,
    lastProcessedInputSeq: p.lastProcessedInputSeq,
  };
}

export function cloneSnapshot(s: Snapshot): Snapshot {
  return {
    tick: s.tick,
    serverTime: s.serverTime,
    players: s.players.map(clonePlayerState),
    pickups: s.pickups.map((pickup) => ({ ...pickup, pos: cloneVec3(pickup.pos) })),
  };
}
