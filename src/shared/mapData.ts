// Hand-authored arena layout based on Kenney Mini Arena (CC0):
// https://kenney-assets.itch.io/mini-arena
import {
  Decoration,
  JumpPad,
  LadderZone,
  LevelBox,
  MovingPlatform,
  PickupSpawn,
  Vec3,
} from "./protocol.ts";

export const MAP_SCALE = 1;

const FLOOR = 0xb98f5b;
const WALL = 0x475569;
const COVER = 0x334155;

export const LEVEL: LevelBox[] = [
  { min: { x: -10, y: -0.5, z: -10 }, max: { x: 10, y: 0, z: 10 }, color: FLOOR },
  { min: { x: -26, y: -0.5, z: -10 }, max: { x: -10, y: 0, z: 10 }, color: FLOOR },
  { min: { x: 10, y: -0.5, z: -10 }, max: { x: 26, y: 0, z: 10 }, color: FLOOR },
  { min: { x: -10, y: -0.5, z: -26 }, max: { x: 10, y: 0, z: -10 }, color: FLOOR },
  { min: { x: -10, y: -0.5, z: 10 }, max: { x: 10, y: 0, z: 26 }, color: FLOOR },
  { min: { x: -26, y: -0.5, z: -26 }, max: { x: -10, y: 0, z: -10 }, color: FLOOR },
  { min: { x: 10, y: -0.5, z: -26 }, max: { x: 26, y: 0, z: -10 }, color: FLOOR },
  { min: { x: -26, y: -0.5, z: 10 }, max: { x: -10, y: 0, z: 26 }, color: FLOOR },
  { min: { x: 10, y: -0.5, z: 10 }, max: { x: 26, y: 0, z: 26 }, color: FLOOR },

  { min: { x: -26.5, y: 0, z: -26.5 }, max: { x: -26, y: 8, z: 26.5 }, color: WALL },
  { min: { x: 26, y: 0, z: -26.5 }, max: { x: 26.5, y: 8, z: 26.5 }, color: WALL },
  { min: { x: -26.5, y: 0, z: -26.5 }, max: { x: 26.5, y: 8, z: -26 }, color: WALL },
  { min: { x: -26.5, y: 0, z: 26 }, max: { x: 26.5, y: 8, z: 26.5 }, color: WALL },

  { min: { x: -22, y: 4, z: -6 }, max: { x: -10, y: 4.5, z: 6 }, color: FLOOR },
  { min: { x: 10, y: 4, z: -6 }, max: { x: 22, y: 4.5, z: 6 }, color: FLOOR },
  { min: { x: -6, y: 4, z: -22 }, max: { x: 6, y: 4.5, z: -10 }, color: FLOOR },
  { min: { x: -6, y: 4, z: 10 }, max: { x: 6, y: 4.5, z: 22 }, color: FLOOR },

  { min: { x: -10, y: 0, z: -3 }, max: { x: -8, y: 1, z: 3 }, color: FLOOR },
  { min: { x: -12, y: 0, z: -3 }, max: { x: -10, y: 2, z: 3 }, color: FLOOR },
  { min: { x: -14, y: 0, z: -3 }, max: { x: -12, y: 3, z: 3 }, color: FLOOR },
  { min: { x: -16, y: 0, z: -3 }, max: { x: -14, y: 4, z: 3 }, color: FLOOR },
  { min: { x: 8, y: 0, z: -3 }, max: { x: 10, y: 1, z: 3 }, color: FLOOR },
  { min: { x: 10, y: 0, z: -3 }, max: { x: 12, y: 2, z: 3 }, color: FLOOR },
  { min: { x: 12, y: 0, z: -3 }, max: { x: 14, y: 3, z: 3 }, color: FLOOR },
  { min: { x: 14, y: 0, z: -3 }, max: { x: 16, y: 4, z: 3 }, color: FLOOR },
  { min: { x: -3, y: 0, z: -10 }, max: { x: 3, y: 1, z: -8 }, color: FLOOR },
  { min: { x: -3, y: 0, z: -12 }, max: { x: 3, y: 2, z: -10 }, color: FLOOR },
  { min: { x: -3, y: 0, z: -14 }, max: { x: 3, y: 3, z: -12 }, color: FLOOR },
  { min: { x: -3, y: 0, z: -16 }, max: { x: 3, y: 4, z: -14 }, color: FLOOR },
  { min: { x: -3, y: 0, z: 8 }, max: { x: 3, y: 1, z: 10 }, color: FLOOR },
  { min: { x: -3, y: 0, z: 10 }, max: { x: 3, y: 2, z: 12 }, color: FLOOR },
  { min: { x: -3, y: 0, z: 12 }, max: { x: 3, y: 3, z: 14 }, color: FLOOR },
  { min: { x: -3, y: 0, z: 14 }, max: { x: 3, y: 4, z: 16 }, color: FLOOR },

  { min: { x: -7.5, y: 0, z: -2.5 }, max: { x: -5.5, y: 2.2, z: 2.5 }, color: COVER },
  { min: { x: 5.5, y: 0, z: -2.5 }, max: { x: 7.5, y: 2.2, z: 2.5 }, color: COVER },
  { min: { x: -2.5, y: 0, z: -7.5 }, max: { x: 2.5, y: 2.2, z: -5.5 }, color: COVER },
  { min: { x: -2.5, y: 0, z: 5.5 }, max: { x: 2.5, y: 2.2, z: 7.5 }, color: COVER },
  { min: { x: -14.5, y: 0, z: -14.5 }, max: { x: -12.5, y: 3.5, z: -12.5 }, color: COVER },
  { min: { x: 12.5, y: 0, z: -14.5 }, max: { x: 14.5, y: 3.5, z: -12.5 }, color: COVER },
  { min: { x: -14.5, y: 0, z: 12.5 }, max: { x: -12.5, y: 3.5, z: 14.5 }, color: COVER },
  { min: { x: 12.5, y: 0, z: 12.5 }, max: { x: 14.5, y: 3.5, z: 14.5 }, color: COVER },
];

export const SPAWN_POINTS: Vec3[] = [
  { x: -20, y: 0.05, z: -20 },
  { x: 20, y: 0.05, z: -20 },
  { x: -20, y: 0.05, z: 20 },
  { x: 20, y: 0.05, z: 20 },
  { x: -18, y: 4.55, z: 0 },
  { x: 18, y: 4.55, z: 0 },
  { x: 0, y: 4.55, z: -18 },
  { x: 0, y: 4.55, z: 18 },
];

export const PICKUP_SPAWNS: PickupSpawn[] = [
  {
    id: "rifle-mid",
    type: "weapon",
    weaponId: "rifle",
    label: "RIFLE",
    pos: { x: 0, y: 0.5, z: -4 },
    respawnMs: 12000,
  },
  {
    id: "shotgun-west",
    type: "weapon",
    weaponId: "shotgun",
    label: "SHOTGUN",
    pos: { x: -18, y: 4.8, z: 0 },
    respawnMs: 15000,
  },
  {
    id: "shotgun-east",
    type: "weapon",
    weaponId: "shotgun",
    label: "SHOTGUN",
    pos: { x: 18, y: 4.8, z: 0 },
    respawnMs: 15000,
  },
  {
    id: "sniper-north",
    type: "weapon",
    weaponId: "sniper",
    label: "SNIPER",
    pos: { x: 0, y: 4.8, z: -18 },
    respawnMs: 18000,
  },
  {
    id: "sniper-south",
    type: "weapon",
    weaponId: "sniper",
    label: "SNIPER",
    pos: { x: 0, y: 4.8, z: 18 },
    respawnMs: 18000,
  },
  {
    id: "ammo-nw",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: -20, y: 0.5, z: -12 },
    respawnMs: 8000,
  },
  {
    id: "ammo-ne",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: 20, y: 0.5, z: -12 },
    respawnMs: 8000,
  },
  {
    id: "ammo-sw",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: -20, y: 0.5, z: 12 },
    respawnMs: 8000,
  },
  {
    id: "ammo-se",
    type: "ammo",
    label: "AMMO",
    amount: 999,
    pos: { x: 20, y: 0.5, z: 12 },
    respawnMs: 8000,
  },
];

export const JUMP_PADS: JumpPad[] = [
  { min: { x: -1.1, y: 0, z: -1.1 }, max: { x: 1.1, y: 0.25, z: 1.1 }, force: 17, color: 0x38bdf8 },
  {
    min: { x: -21.2, y: 0, z: -21.2 },
    max: { x: -18.8, y: 0.25, z: -18.8 },
    force: 14,
    color: 0x22d3ee,
  },
  {
    min: { x: 18.8, y: 0, z: -21.2 },
    max: { x: 21.2, y: 0.25, z: -18.8 },
    force: 14,
    color: 0x22d3ee,
  },
  {
    min: { x: -21.2, y: 0, z: 18.8 },
    max: { x: -18.8, y: 0.25, z: 21.2 },
    force: 14,
    color: 0x22d3ee,
  },
  {
    min: { x: 18.8, y: 0, z: 18.8 },
    max: { x: 21.2, y: 0.25, z: 21.2 },
    force: 14,
    color: 0x22d3ee,
  },
];

export const MOVING_PLATFORMS: MovingPlatform[] = [];
export const LADDERS: LadderZone[] = [];
export const DECORATIONS: Decoration[] = [
  { id: "light-nw", kind: "light", pos: { x: -23, y: 0, z: -23 }, color: 0xfacc15 },
  { id: "light-ne", kind: "light", pos: { x: 23, y: 0, z: -23 }, color: 0xfacc15 },
  { id: "light-sw", kind: "light", pos: { x: -23, y: 0, z: 23 }, color: 0xfacc15 },
  { id: "light-se", kind: "light", pos: { x: 23, y: 0, z: 23 }, color: 0xfacc15 },
  { id: "antenna-west", kind: "antenna", pos: { x: -18, y: 4.5, z: -7 }, color: 0x38bdf8 },
  { id: "antenna-east", kind: "antenna", pos: { x: 18, y: 4.5, z: 7 }, color: 0x38bdf8 },
];
