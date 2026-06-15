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
  spread?: number; // base/min angular deviation in radians
  spreadMax?: number; // max angular deviation after sustained fire
  spreadRampMs?: number; // ms of continuous fire to reach spreadMax
  spreadRecoveryMs?: number; // ms to recover from spreadMax back to spread
  pelletCount?: number; // >1 = shotgun-style multi-projectile
  automatic?: boolean; // hold fire to shoot continuously
}

export const WEAPONS: WeaponConfig[] = [
  {
    id: "pistol",
    name: "Pistol",
    damage: 25,
    cooldownMs: 300,
    maxAmmo: 12,
    reloadMs: 1000,
    spread: 0.02,
    spreadMax: 0.08,
    spreadRampMs: 600,
    spreadRecoveryMs: 350,
    automatic: true,
  },
  {
    id: "rifle",
    name: "Rifle",
    damage: 18,
    cooldownMs: 100,
    maxAmmo: 30,
    reloadMs: 1500,
    spread: 0.035,
    spreadMax: 0.14,
    spreadRampMs: 900,
    spreadRecoveryMs: 400,
    automatic: true,
  },
  {
    id: "sniper",
    name: "Sniper",
    damage: 80,
    cooldownMs: 1200,
    maxAmmo: 5,
    reloadMs: 2000,
    spread: 0.008,
    spreadMax: 0.03,
    spreadRampMs: 500,
    spreadRecoveryMs: 300,
  },
  {
    id: "shotgun",
    name: "Shotgun",
    damage: 11,
    cooldownMs: 950,
    maxAmmo: 8,
    reloadMs: 2400,
    spread: 0.08,
    spreadMax: 0.12,
    spreadRampMs: 400,
    spreadRecoveryMs: 300,
    pelletCount: 8,
  },
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
  reloadEndTick: number;
  spreadAccumMs: number;
  lastSpreadUpdateTick: number;
  kills: number;
  deaths: number;
  score: number;
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
  | { type: "welcome"; id: string; tick: number; roomId: string; roomName: string; isHost: boolean }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "fire"; event: FireEvent }
  | { type: "hit"; victimId: string; damage: number; hp: number }
  | { type: "pickup"; label: string }
  | { type: "pong"; clientTime: number; serverTime: number }
  | { type: "room_info"; roomId: string; name: string; hasPassword: boolean; hostId: string }
  | { type: "error"; message: string };

export type ClientMsg =
  | { type: "state"; state: ClientStateUpdate }
  | { type: "ping"; clientTime: number }
  | { type: "room_update"; name?: string; password?: string; maxPlayers?: number };

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

export function movingPlatformPosition(platform: MovingPlatform, timeMs: number): Vec3 {
  const phase = (timeMs % platform.periodMs) / platform.periodMs;
  const t = 0.5 - Math.cos(phase * Math.PI * 2) * 0.5;
  return {
    x: platform.from.x + (platform.to.x - platform.from.x) * t,
    y: platform.from.y + (platform.to.y - platform.from.y) * t,
    z: platform.from.z + (platform.to.z - platform.from.z) * t,
  };
}

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
    reloadEndTick: p.reloadEndTick,
    spreadAccumMs: p.spreadAccumMs,
    lastSpreadUpdateTick: p.lastSpreadUpdateTick,
    kills: p.kills,
    deaths: p.deaths,
    score: p.score,
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
