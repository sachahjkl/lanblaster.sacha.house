import * as THREE from "three";
import { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { PickupState, PlayerState, Vec3, movingPlatformPosition } from "../shared/protocol.ts";
import {
  DECORATIONS,
  JUMP_PADS,
  LADDERS,
  LEVEL,
  MAP_SCALE,
  MOVING_PLATFORMS,
} from "../shared/mapData.ts";
import { SETTINGS } from "../shared/settings.ts";

const OVERHEAD_UI = {
  baseOffset: 2.0,
  height: 0.82,
} as const;

// CC0 textures from Poly Haven. Runtime-loaded with generated material fallback.
const TEXTURE_URLS = {
  floor: {
    map: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/cobblestone_floor_07/cobblestone_floor_07_diff_1k.jpg",
    normalMap:
      "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/cobblestone_floor_07/cobblestone_floor_07_nor_gl_1k.jpg",
    roughnessMap:
      "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/cobblestone_floor_07/cobblestone_floor_07_rough_1k.jpg",
  },
  wall: {
    map: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/stone_wall_02/stone_wall_02_diff_1k.jpg",
    normalMap:
      "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/stone_wall_02/stone_wall_02_nor_gl_1k.jpg",
    roughnessMap:
      "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/stone_wall_02/stone_wall_02_rough_1k.jpg",
  },
} as const;

const SKYBOX_URLS = [
  "/assets/skybox/sky_72_2k/px.png",
  "/assets/skybox/sky_72_2k/nx.png",
  "/assets/skybox/sky_72_2k/py.png",
  "/assets/skybox/sky_72_2k/ny.png",
  "/assets/skybox/sky_72_2k/pz.png",
  "/assets/skybox/sky_72_2k/nz.png",
] as const;

export interface RendererSettings {
  brightness: number;
  shadows: boolean;
}

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  visualMapGroup = new THREE.Group();
  players = new Map<string, THREE.Mesh>();
  weapons = new Map<string, THREE.Object3D>();
  nameplates = new Map<string, THREE.Sprite>();
  pickupMeshes = new Map<string, THREE.Mesh>();
  pickupLabels = new Map<string, THREE.Sprite>();
  movingPlatformMeshes = new Map<string, THREE.Mesh>();
  loader = new GLTFLoader();
  characterModel: THREE.Object3D | null = null;
  weaponModels = new Map<string, THREE.Object3D>();
  propModels = new Map<string, THREE.Object3D>();
  firstPersonWeapon: THREE.Object3D | null = null;
  firstPersonWeaponId: string | null = null;
  headSwayTime = 0;
  headSwayAmount = 0;
  leanAmount = 0;
  aimAmount = 0;
  crouchAmount = 0;
  playerModelRoots = new Map<string, THREE.Object3D>();
  playerAimRigs = new Map<
    string,
    {
      bodyYaw: number;
      head?: THREE.Bone;
      neck?: THREE.Bone;
      headBase?: THREE.Euler;
      neckBase?: THREE.Euler;
    }
  >();
  localPlayerId: string | null = null;
  tracers: { mesh: THREE.Line; life: number }[] = [];
  projectiles: {
    mesh: THREE.Mesh;
    trail: THREE.Line;
    from: THREE.Vector3;
    to: THREE.Vector3;
    age: number;
    duration: number;
  }[] = [];
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
  accentLight: THREE.PointLight;
  ready: Promise<void>;
  floorMaterial = this.createPatternMaterial(0xc9a66b, 0x9f7c4c, 96, 96);
  wallMaterial = this.createPatternMaterial(0x475569, 0x1e293b, 96, 96);
  texturedWallColors = new Set([0x334455, 0x445566, 0x334155, 0x475569, 0x1e293b]);

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    this.camera = new THREE.PerspectiveCamera(75, canvas.width / canvas.height, 0.1, 1000);
    this.scene.add(this.camera);

    // Lights
    const ambient = new THREE.HemisphereLight(0xbfe9ff, 0x4b2f1c, 1.08);
    this.scene.add(ambient);
    this.keyLight = new THREE.DirectionalLight(0xfff2d0, 2.35);
    this.keyLight.position.set(-90, 180, 70);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 500;
    this.keyLight.shadow.camera.left = -150;
    this.keyLight.shadow.camera.right = 150;
    this.keyLight.shadow.camera.top = 150;
    this.keyLight.shadow.camera.bottom = -150;
    this.scene.add(this.keyLight);
    this.fillLight = new THREE.DirectionalLight(0x9be7ff, 0.7);
    this.fillLight.position.set(120, 50, -130);
    this.scene.add(this.fillLight);
    this.accentLight = new THREE.PointLight(0xf97316, 2.5, 160);
    this.accentLight.position.set(0, 48, 0);
    this.scene.add(this.accentLight);

    this.scene.fog = new THREE.Fog(0x87ceeb, 120, 360);

    // Visual level is loaded from the OBJ; physics uses LEVEL directly.
    this.addJumpPadVisuals();
    this.addMovingPlatformVisuals();
    this.addLadderVisuals();
    this.addDecorations();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(canvas.width, canvas.height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.28;

    this.ready = Promise.allSettled([
      this.loadSkybox(),
      this.loadEnvironmentTextures(),
      this.loadAssets(),
      this.loadObjMap(),
    ]).then(() => undefined);
  }

  applySettings(settings: RendererSettings) {
    this.renderer.shadowMap.enabled = settings.shadows;
    this.keyLight.castShadow = settings.shadows;
    this.renderer.toneMappingExposure = settings.brightness;
  }

  async loadSkybox() {
    try {
      const texture = await new Promise<THREE.CubeTexture>((resolve, reject) => {
        new THREE.CubeTextureLoader().load([...SKYBOX_URLS], resolve, undefined, reject);
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = texture;
    } catch (err) {
      console.warn("Skybox loading failed, using flat sky color", err);
    }
  }

  async loadEnvironmentTextures() {
    try {
      const [floor, wall] = await Promise.all([
        this.createRemoteMaterial(TEXTURE_URLS.floor, 14),
        this.createRemoteMaterial(TEXTURE_URLS.wall, 5),
      ]);
      this.floorMaterial.copy(floor);
      this.floorMaterial.needsUpdate = true;
      this.wallMaterial.copy(wall);
      this.wallMaterial.needsUpdate = true;
    } catch (err) {
      console.warn("CC0 texture loading failed, using generated fallback", err);
    }
  }

  async createRemoteMaterial(
    urls: { map: string; normalMap: string; roughnessMap: string },
    repeat: number,
  ): Promise<THREE.MeshStandardMaterial> {
    const loader = new THREE.TextureLoader();
    const load = (url: string) =>
      new Promise<THREE.Texture>((resolve, reject) => loader.load(url, resolve, undefined, reject));
    const [map, normalMap, roughnessMap] = await Promise.all([
      load(urls.map),
      load(urls.normalMap),
      load(urls.roughnessMap),
    ]);

    for (const texture of [map, normalMap, roughnessMap]) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat, repeat);
      texture.colorSpace = texture === map ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    }

    return new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap,
      roughness: 0.9,
    });
  }

  createPatternMaterial(
    base: number,
    accent: number,
    width: number,
    height: number,
  ): THREE.MeshStandardMaterial {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `#${base.toString(16).padStart(6, "0")}`;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = `#${accent.toString(16).padStart(6, "0")}`;
    ctx.globalAlpha = 0.35;
    for (let x = 0; x < width; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 8, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 16) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 8);
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 });
  }

  createNoiseTexture(size = 256): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 64;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    return texture;
  }

  addVisualGround() {
    const ground = new THREE.Mesh(new THREE.BoxGeometry(512, 0.2, 512), this.floorMaterial);
    ground.receiveShadow = true;
    ground.position.set(0, -0.12, 0);
    const map = this.floorMaterial.map;
    if (map) {
      map.repeat.set(48, 48);
    }
    this.scene.add(ground);
  }

  addColliderVisuals() {
    const materials = new Map<number, THREE.MeshStandardMaterial>();
    const getMaterial = (color: number) => {
      let mat = materials.get(color);
      if (!mat) {
        mat = this.texturedWallColors.has(color)
          ? this.wallMaterial
          : new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
        materials.set(color, mat);
      }
      return mat;
    };

    for (const box of LEVEL) {
      // Ground is rendered as the big tan floor already.
      if (box.min.y < 0 && box.max.y <= 0) continue;

      const sx = box.max.x - box.min.x;
      const sy = box.max.y - box.min.y;
      const sz = box.max.z - box.min.z;
      const cx = (box.min.x + box.max.x) * 0.5;
      const cy = (box.min.y + box.max.y) * 0.5;
      const cz = (box.min.z + box.max.z) * 0.5;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        getMaterial(box.color ?? 0xb98f5b),
      );
      mesh.position.set(cx, cy, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.visualMapGroup.add(mesh);
    }
  }

  async loadAssets() {
    const load = (path: string) =>
      new Promise<THREE.Object3D>((resolve, reject) => {
        this.loader.load(
          path,
          (gltf: GLTF) => {
            this.sanitizeLoadedModel(gltf.scene);
            resolve(gltf.scene);
          },
          undefined,
          reject,
        );
      });

    try {
      this.characterModel = await load(
        "/assets/kenney/mini-arena/Models/GLB%20format/character-soldier.glb",
      );
      this.characterModel.scale.setScalar(3.0);

      this.weaponModels.set(
        "pistol",
        await load("/assets/kenney/blaster-kit/Models/GLB%20format/blaster-a.glb"),
      );
      this.weaponModels.set(
        "rifle",
        await load("/assets/kenney/blaster-kit/Models/GLB%20format/blaster-r.glb"),
      );
      this.weaponModels.set(
        "sniper",
        await load("/assets/kenney/blaster-kit/Models/GLB%20format/blaster-j.glb"),
      );
      this.weaponModels.set(
        "shotgun",
        await load("/assets/kenney/blaster-kit/Models/GLB%20format/blaster-d.glb"),
      );
      this.propModels.set(
        "crate",
        await load("/assets/kenney/blaster-kit/Models/GLB%20format/crate-medium.glb"),
      );
      this.propModels.set(
        "scifi-crate",
        await load("/assets/online/poly-pizza/scifi-crate-quaternius.glb"),
      );
      this.propModels.set(
        "statue",
        await load("/assets/kenney/mini-arena/Models/GLB%20format/statue.glb"),
      );
      this.propModels.set(
        "banner",
        await load("/assets/kenney/mini-arena/Models/GLB%20format/banner.glb"),
      );
      this.propModels.set(
        "column",
        await load("/assets/kenney/mini-arena/Models/GLB%20format/column.glb"),
      );
      this.propModels.set(
        "tree",
        await load("/assets/kenney/mini-arena/Models/GLB%20format/tree.glb"),
      );
      this.addLoadedProps();
      this.firstPersonWeaponId = null;
    } catch (err) {
      console.warn("Asset loading failed, using primitive fallback", err);
    }
  }

  async loadObjMap() {
    try {
      const loader = new OBJLoader();
      const group = await new Promise<THREE.Group>((resolve, reject) => {
        loader.load("/assets/online/afps-level/level.obj", resolve, undefined, reject);
      });
      const mapTexture = this.createNoiseTexture();
      const mapMaterial = new THREE.MeshStandardMaterial({
        color: 0x8899aa,
        map: mapTexture,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      group.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = mapMaterial;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      group.scale.setScalar(MAP_SCALE);
      this.visualMapGroup.add(group);
      this.addVisualGround();
      this.scene.add(this.visualMapGroup);
    } catch (err) {
      console.warn("Map OBJ loading failed, using generated fallback", err);
      this.addVisualGround();
      this.buildDustLikeVisualMap();
    }
  }

  sanitizeLoadedModel(root: THREE.Object3D) {
    root.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;

      // Keep loaded asset index buffers compatible across browser renderers.
      const index = geometry.index;
      if (index?.array instanceof Uint8Array) {
        geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(index.array), 1));
      }

      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const mat of materials) {
        mat.side = THREE.DoubleSide;
        mat.needsUpdate = true;
      }
    });
  }

  angleDelta(target: number, current: number): number {
    return Math.atan2(Math.sin(target - current), Math.cos(target - current));
  }

  clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  discoverAimRig(root: THREE.Object3D, initialYaw: number) {
    let head: THREE.Bone | undefined;
    let neck: THREE.Bone | undefined;

    root.traverse((child: THREE.Object3D) => {
      if (!(child instanceof THREE.Bone)) return;
      const name = child.name.toLowerCase();
      if (!head && name.includes("head")) head = child;
      if (!neck && name.includes("neck")) neck = child;
    });

    return {
      bodyYaw: initialYaw,
      head,
      neck,
      headBase: head?.rotation.clone(),
      neckBase: neck?.rotation.clone(),
    };
  }

  updateAimRig(id: string, root: THREE.Object3D, state: PlayerState) {
    let rig = this.playerAimRigs.get(id);
    if (!rig) {
      rig = this.discoverAimRig(root, state.yaw);
      this.playerAimRigs.set(id, rig);
    }

    const bodyDelta = this.angleDelta(state.yaw, rig.bodyYaw);
    rig.bodyYaw += bodyDelta * 0.12;
    root.rotation.y = -rig.bodyYaw + Math.PI;

    const headDelta = this.clamp(this.angleDelta(state.yaw, rig.bodyYaw), -1.0, 1.0);
    const pitch = this.clamp(state.pitch, -0.8, 0.8);

    if (rig.neck && rig.neckBase) {
      rig.neck.rotation.copy(rig.neckBase);
      rig.neck.rotation.y += -headDelta * 0.35;
      rig.neck.rotation.x += pitch * 0.25;
    }

    if (rig.head && rig.headBase) {
      rig.head.rotation.copy(rig.headBase);
      rig.head.rotation.y += -headDelta * 0.75;
      rig.head.rotation.x += pitch * 0.55;
    }
  }

  buildDustLikeVisualMap() {
    this.scene.add(this.visualMapGroup);
    this.addColliderVisuals();
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb98f5b, roughness: 0.85 });
    const accentMatA = new THREE.MeshStandardMaterial({ color: 0xc97b63, roughness: 0.8 });
    const accentMatB = new THREE.MeshStandardMaterial({ color: 0x6b8c42, roughness: 0.8 });
    const accentMatC = new THREE.MeshStandardMaterial({ color: 0x5c8cb8, roughness: 0.8 });
    const routeMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.45,
      emissive: 0x3f2f05,
    });

    const box = (
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      mat: THREE.Material,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      mesh.position.set(x, y + sy / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.visualMapGroup.add(mesh);
    };

    // Lane color strips.
    box(0, 0.01, -24, 80, 0.05, 9, accentMatA);
    box(0, 0.015, 0, 76, 0.05, 7, accentMatB);
    box(0, 0.02, 24, 80, 0.05, 9, accentMatC);

    // Gold route markers show intended pushes and traversal loops.
    box(-20, 0.07, -24, 28, 0.05, 1.2, routeMat);
    box(20, 0.07, 24, 28, 0.05, 1.2, routeMat);
    box(-31.5, 0.09, 14.5, 25, 0.05, 0.8, routeMat);
    box(31.5, 0.09, -14.5, 25, 0.05, 0.8, routeMat);

    // Visual-only accents that do not collide.
    box(0, 0.02, 0, 4, 0.08, 4, wallMat);

    const tunnelMat = this.wallMaterial;
    box(-31.5, 0.02, 14.5, 27, 0.08, 5, tunnelMat);
    box(31.5, 0.02, -14.5, 27, 0.08, 5, tunnelMat);
  }

  addJumpPadVisuals() {
    for (const pad of JUMP_PADS) {
      const sx = pad.max.x - pad.min.x;
      const sy = pad.max.y - pad.min.y;
      const sz = pad.max.z - pad.min.z;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.max(sx, sz) * 0.55, Math.max(sx, sz) * 0.48, sy, 32),
        new THREE.MeshStandardMaterial({
          color: pad.color ?? 0x38bdf8,
          emissive: pad.color ?? 0x38bdf8,
          emissiveIntensity: 0.55,
          roughness: 0.35,
        }),
      );
      mesh.position.set(
        (pad.min.x + pad.max.x) * 0.5,
        (pad.min.y + pad.max.y) * 0.5,
        (pad.min.z + pad.max.z) * 0.5,
      );
      this.scene.add(mesh);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.max(sx, sz) * 0.42, 0.07, 8, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      ring.position.copy(mesh.position);
      ring.position.y += sy * 0.65;
      ring.rotation.x = Math.PI * 0.5;
      this.scene.add(ring);
    }
  }

  addMovingPlatformVisuals() {
    for (const platform of MOVING_PLATFORMS) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(platform.size.x, platform.size.y, platform.size.z),
        new THREE.MeshStandardMaterial({
          color: platform.color ?? 0xf97316,
          emissive: platform.color ?? 0xf97316,
          emissiveIntensity: 0.18,
          metalness: 0.25,
          roughness: 0.35,
        }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.movingPlatformMeshes.set(platform.id, mesh);
    }
  }

  addLadderVisuals() {
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      metalness: 0.45,
      roughness: 0.35,
    });
    const rungMat = new THREE.MeshStandardMaterial({
      color: 0xe5e7eb,
      metalness: 0.35,
      roughness: 0.4,
    });
    for (const ladder of LADDERS) {
      const cx = (ladder.min.x + ladder.max.x) * 0.5;
      const cz = (ladder.min.z + ladder.max.z) * 0.5;
      const h = ladder.max.y - ladder.min.y;
      const zWide = ladder.max.z - ladder.min.z > ladder.max.x - ladder.min.x;
      const railOffset = zWide ? { x: 0, z: 0.42 } : { x: 0.42, z: 0 };
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.12), railMat);
        rail.position.set(
          cx + railOffset.x * side,
          ladder.min.y + h * 0.5,
          cz + railOffset.z * side,
        );
        rail.castShadow = true;
        this.scene.add(rail);
      }
      for (let y = ladder.min.y + 0.7; y < ladder.max.y; y += 0.75) {
        const rung = new THREE.Mesh(
          zWide ? new THREE.BoxGeometry(0.14, 0.08, 0.9) : new THREE.BoxGeometry(0.9, 0.08, 0.14),
          rungMat,
        );
        rung.position.set(cx, y, cz);
        rung.castShadow = true;
        this.scene.add(rung);
      }
    }
  }

  addDecorations() {
    for (const deco of DECORATIONS) {
      if (deco.kind === "light") {
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.16, 4.2, 10),
          new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.5, roughness: 0.45 }),
        );
        pole.position.set(deco.pos.x, deco.pos.y + 2.1, deco.pos.z);
        pole.castShadow = true;
        this.scene.add(pole);
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 16, 12),
          new THREE.MeshBasicMaterial({ color: deco.color ?? 0xffffff }),
        );
        bulb.position.set(deco.pos.x, deco.pos.y + 4.35, deco.pos.z);
        this.scene.add(bulb);
        const light = new THREE.PointLight(deco.color ?? 0xffffff, 0.85, 15);
        light.position.copy(bulb.position);
        this.scene.add(light);
      } else if (deco.kind === "crate") {
        const crateModel = this.propModels.get("scifi-crate") ?? this.propModels.get("crate");
        const crate = crateModel
          ? crateModel.clone(true)
          : new THREE.Mesh(
              new THREE.BoxGeometry(1.6, 1.1, 1.6),
              new THREE.MeshStandardMaterial({ color: 0x7c5f38, roughness: 0.9 }),
            );
        crate.position.set(deco.pos.x, deco.pos.y + 0.55, deco.pos.z);
        crate.rotation.y = deco.yaw ?? 0;
        crate.scale.setScalar(crateModel ? 1.8 : 1);
        crate.castShadow = true;
        crate.traverse((child: THREE.Object3D) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        this.scene.add(crate);
      } else if (deco.kind === "obelisk") {
        const statueModel = this.propModels.get("statue");
        const obelisk = statueModel
          ? statueModel.clone(true)
          : new THREE.Mesh(
              new THREE.ConeGeometry(0.9, 3.2, 4),
              new THREE.MeshStandardMaterial({
                color: deco.color ?? 0xa78bfa,
                emissive: 0x2e1065,
                roughness: 0.5,
              }),
            );
        obelisk.position.set(deco.pos.x, deco.pos.y + 1.6, deco.pos.z);
        obelisk.rotation.y = Math.PI * 0.25;
        obelisk.scale.setScalar(statueModel ? 2.4 : 1);
        obelisk.castShadow = true;
        this.scene.add(obelisk);
      } else {
        const antenna = new THREE.Group();
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8),
          new THREE.MeshStandardMaterial({ color: 0xe5e7eb, metalness: 0.6, roughness: 0.3 }),
        );
        mast.position.y = 1.6;
        antenna.add(mast);
        const dish = new THREE.Mesh(
          new THREE.ConeGeometry(0.6, 0.35, 24),
          new THREE.MeshStandardMaterial({
            color: deco.color ?? 0xfacc15,
            metalness: 0.4,
            roughness: 0.35,
          }),
        );
        dish.position.y = 3.0;
        dish.rotation.x = Math.PI * 0.5;
        antenna.add(dish);
        antenna.position.set(deco.pos.x, deco.pos.y, deco.pos.z);
        this.scene.add(antenna);
      }
    }
  }

  addLoadedProps() {
    const placements = [
      { key: "banner", pos: new THREE.Vector3(-10, 0, -34), scale: 2.2, yaw: 0.2 },
      { key: "banner", pos: new THREE.Vector3(10, 0, 34), scale: 2.2, yaw: Math.PI + 0.2 },
      { key: "scifi-crate", pos: new THREE.Vector3(-26, 0, -18), scale: 1.8, yaw: 0.35 },
      { key: "scifi-crate", pos: new THREE.Vector3(26, 0, 18), scale: 1.8, yaw: -0.35 },
      { key: "column", pos: new THREE.Vector3(-14, 0, 10), scale: 2.0, yaw: 0 },
      { key: "column", pos: new THREE.Vector3(14, 0, -10), scale: 2.0, yaw: 0 },
      { key: "tree", pos: new THREE.Vector3(-42, 0, 28), scale: 2.6, yaw: -0.4 },
      { key: "tree", pos: new THREE.Vector3(42, 0, -28), scale: 2.6, yaw: 0.4 },
    ];

    for (const placement of placements) {
      const model = this.propModels.get(placement.key);
      if (!model) continue;
      const prop = model.clone(true);
      prop.position.copy(placement.pos);
      prop.rotation.y = placement.yaw;
      prop.scale.setScalar(placement.scale);
      prop.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      this.scene.add(prop);
    }
  }

  updateMovingPlatforms(timeMs: number) {
    for (const platform of MOVING_PLATFORMS) {
      const mesh = this.movingPlatformMeshes.get(platform.id);
      if (!mesh) continue;
      const pos = movingPlatformPosition(platform, timeMs);
      mesh.position.set(pos.x, pos.y, pos.z);
    }
  }

  updatePickups(pickups: PickupState[]) {
    const seen = new Set<string>();
    for (const pickup of pickups) {
      seen.add(pickup.id);
      let mesh = this.pickupMeshes.get(pickup.id);
      if (!mesh) {
        const pickupLabel = pickup.label ?? pickup.weaponId?.toUpperCase() ?? "AMMO";
        const color =
          pickup.type === "ammo" ? 0x22c55e : pickup.weaponId === "sniper" ? 0xef4444 : 0xfacc15;
        mesh = new THREE.Mesh(
          pickup.type === "ammo"
            ? new THREE.BoxGeometry(0.8, 0.8, 0.8)
            : new THREE.OctahedronGeometry(0.75),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.pickupMeshes.set(pickup.id, mesh);
        const label = this.createTextSprite(pickupLabel, "#ffffff", "rgba(0,0,0,0.72)", 2.1, 0.52);
        this.scene.add(label);
        this.pickupLabels.set(pickup.id, label);
      }

      mesh.position.set(
        pickup.pos.x,
        pickup.pos.y + 0.9 + Math.sin(performance.now() * 0.004) * 0.08,
        pickup.pos.z,
      );
      mesh.rotation.y += 0.035;
      mesh.visible = pickup.active;
      const label = this.pickupLabels.get(pickup.id);
      if (label) {
        label.position.set(pickup.pos.x, pickup.pos.y + 2.1, pickup.pos.z);
        label.visible = pickup.active;
      }
    }

    for (const [id, mesh] of this.pickupMeshes) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.pickupMeshes.delete(id);
      const label = this.pickupLabels.get(id);
      if (label) {
        this.scene.remove(label);
        label.material.map?.dispose();
        label.material.dispose();
        this.pickupLabels.delete(id);
      }
    }
  }

  createTextSprite(
    text: string,
    color: string,
    background: string,
    width: number,
    height: number,
  ): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = background;
    ctx.fillRect(24, 24, 464, 80);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.strokeRect(24, 24, 464, 80);
    ctx.font = "900 46px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 66);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(width, height, 1);
    sprite.renderOrder = 9;
    return sprite;
  }

  setLocalPlayer(id: string) {
    this.localPlayerId = id;
  }

  updatePlayer(state: PlayerState, isLocal: boolean) {
    if (isLocal) {
      this.removePlayer(state.id);
      return;
    }

    let mesh = this.players.get(state.id);
    if (!mesh) {
      const geo = new THREE.CapsuleGeometry(0.4, 0.8, 4, 16);
      const mat = new THREE.MeshStandardMaterial({
        color: isLocal ? 0x00ff00 : 0xff4444,
        roughness: 0.5,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.players.set(state.id, mesh);

      // Weapon mesh
      const wMesh = this.createWeaponMesh(state.weaponId);
      this.scene.add(wMesh);
      this.weapons.set(state.id, wMesh);

      const nameplate = this.createNameplate(state);
      this.scene.add(nameplate);
      this.nameplates.set(state.id, nameplate);
    }

    const bodyHeight = state.crouching ? 0.65 : 1.2;
    const bodyY = state.pos.y + bodyHeight;
    mesh.position.set(state.pos.x, bodyY, state.pos.z);
    let root = this.playerModelRoots.get(state.id);
    if (!root && this.characterModel) {
      root = cloneSkeleton(this.characterModel);
      root.scale.set(3.0, state.crouching ? 2.25 : 3.0, 3.0);
      this.scene.add(root);
      this.playerModelRoots.set(state.id, root);
    }
    if (root) {
      root.scale.set(3.0, state.crouching ? 2.25 : 3.0, 3.0);
      root.position.set(state.pos.x, state.pos.y, state.pos.z);
      this.updateAimRig(state.id, root, state);
      root.visible = !state.dead;
      mesh.visible = false;
    } else {
      mesh.visible = !state.dead;
    }

    // Update weapon position: forward plus right-hand offset, matching -Z forward convention.
    let weapon = this.weapons.get(state.id)!;
    if (weapon.userData.weaponId !== state.weaponId) {
      this.scene.remove(weapon);
      weapon = this.createWeaponMesh(state.weaponId);
      this.scene.add(weapon);
      this.weapons.set(state.id, weapon);
    }
    const cy = Math.cos(state.yaw);
    const sy = Math.sin(state.yaw);
    const forwardX = sy;
    const forwardZ = -cy;
    const rightX = cy;
    const rightZ = sy;
    const rightHandOffset = SETTINGS.weaponVisuals.rightHandOffset;
    const forwardHandOffset = SETTINGS.weaponVisuals.forwardHandOffset;
    const wx = state.pos.x + forwardX * forwardHandOffset + rightX * rightHandOffset;
    const wz = state.pos.z + forwardZ * forwardHandOffset + rightZ * rightHandOffset;
    weapon.position.set(wx, state.pos.y + SETTINGS.weaponVisuals.handHeight, wz);
    weapon.rotation.y = -state.yaw;
    weapon.visible = !state.dead;

    const nameY = bodyY + OVERHEAD_UI.baseOffset;

    const nameplate = this.nameplates.get(state.id)!;
    if (nameplate.userData.name !== state.name || nameplate.userData.hp !== state.hp) {
      this.replaceNameplate(state.id, state);
      const updatedNameplate = this.nameplates.get(state.id)!;
      updatedNameplate.position.set(state.pos.x, nameY, state.pos.z);
      updatedNameplate.visible = !state.dead;
    } else {
      nameplate.position.set(state.pos.x, nameY, state.pos.z);
      nameplate.visible = !state.dead;
    }
  }

  createNameplate(state: PlayerState): THREE.Sprite {
    const hpRatio = Math.max(0, Math.min(1, state.hp / state.maxHp));
    const hpColor = hpRatio > 0.5 ? "#22c55e" : hpRatio > 0.25 ? "#facc15" : "#ef4444";
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "900 44px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0, 0, 0, 0.82)";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(12, 10, 488, 108, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#facc15";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 8;
    ctx.strokeText(state.name, 256, 43);
    ctx.fillText(state.name, 256, 43);

    ctx.fillStyle = "#020617";
    ctx.fillRect(72, 74, 368, 34);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.strokeRect(72, 74, 368, 34);
    ctx.fillStyle = hpColor;
    ctx.fillRect(76, 78, 360 * hpRatio, 26);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.7, OVERHEAD_UI.height, 1);
    sprite.renderOrder = 10;
    sprite.userData.name = state.name;
    sprite.userData.hp = state.hp;
    return sprite;
  }

  replaceNameplate(id: string, state: PlayerState) {
    const current = this.nameplates.get(id);
    if (current) {
      this.scene.remove(current);
      current.material.map?.dispose();
      current.material.dispose();
    }
    const next = this.createNameplate(state);
    this.scene.add(next);
    this.nameplates.set(id, next);
  }

  createWeaponMesh(weaponId: string): THREE.Object3D {
    const model = this.weaponModels.get(weaponId);
    if (model) {
      const root = model.clone(true);
      root.userData.weaponId = weaponId;
      root.scale.setScalar(0.55);
      return root;
    }

    const wGeo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
    const wMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const wMesh = new THREE.Mesh(wGeo, wMat);
    wMesh.userData.weaponId = weaponId;
    return wMesh;
  }

  updateFirstPersonWeapon(state: PlayerState, dt = 0, aiming = false, reloadProgress = 0) {
    if (!this.firstPersonWeapon || this.firstPersonWeaponId !== state.weaponId) {
      if (this.firstPersonWeapon) this.camera.remove(this.firstPersonWeapon);
      this.firstPersonWeapon = this.createWeaponMesh(state.weaponId);
      this.firstPersonWeaponId = state.weaponId;
      this.firstPersonWeapon.scale.multiplyScalar(1.2);
      this.camera.add(this.firstPersonWeapon);
    }

    const targetAim = aiming && !state.dead ? 1 : 0;
    this.aimAmount += (targetAim - this.aimAmount) * (1 - Math.exp(-dt * 18));
    const reloadCurve = Math.sin(Math.max(0, Math.min(1, reloadProgress)) * Math.PI);
    this.firstPersonWeapon.position.set(
      0.42 + (0.02 - 0.42) * this.aimAmount,
      -0.34 + (-0.23 + 0.34) * this.aimAmount - reloadCurve * 0.25,
      -0.72 + (-0.58 + 0.72) * this.aimAmount,
    );
    this.firstPersonWeapon.rotation.set(
      -0.08 + reloadCurve * 0.35,
      0,
      -0.06 + 0.06 * this.aimAmount - reloadCurve * 0.2,
    );
    this.firstPersonWeapon.visible = !state.dead;
  }

  removePlayer(id: string) {
    const mesh = this.players.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.players.delete(id);
    }
    const root = this.playerModelRoots.get(id);
    if (root) {
      this.scene.remove(root);
      this.playerModelRoots.delete(id);
      this.playerAimRigs.delete(id);
    }
    const w = this.weapons.get(id);
    if (w) {
      this.scene.remove(w);
      this.weapons.delete(id);
    }
    const nameplate = this.nameplates.get(id);
    if (nameplate) {
      this.scene.remove(nameplate);
      nameplate.material.map?.dispose();
      nameplate.material.dispose();
      this.nameplates.delete(id);
    }
  }

  addTracer(from: Vec3, to: Vec3) {
    const start = new THREE.Vector3(from.x, from.y, from.z);
    const end = new THREE.Vector3(to.x, to.y, to.z);
    const distance = start.distanceTo(end);
    const duration = Math.max(0.045, Math.min(0.18, distance / 260));
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff7ad }),
    );
    mesh.position.copy(start);

    const trail = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([start, start]),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 }),
    );
    this.scene.add(mesh);
    this.scene.add(trail);
    this.projectiles.push({ mesh, trail, from: start, to: end, age: 0, duration });
  }

  updateTracers(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      const t = Math.min(1, p.age / p.duration);
      const pos = p.from.clone().lerp(p.to, t);
      const back = p.from.clone().lerp(p.to, Math.max(0, t - 0.08));
      p.mesh.position.copy(pos);
      p.trail.geometry.dispose();
      p.trail.geometry = new THREE.BufferGeometry().setFromPoints([back, pos]);
      (p.trail.material as THREE.LineBasicMaterial).opacity = 1 - t * 0.45;
      if (t >= 1) {
        this.scene.remove(p.mesh);
        this.scene.remove(p.trail);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        p.trail.geometry.dispose();
        (p.trail.material as THREE.Material).dispose();
        this.projectiles.splice(i, 1);
      }
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt * 5;
      (t.mesh.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life);
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        (t.mesh.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  setCameraFromPlayer(
    state: PlayerState,
    dt = 0,
    headSwayEnabled = false,
    leanInput = 0,
    aiming = false,
  ) {
    const targetCrouch = state.crouching ? 1 : 0;
    this.crouchAmount += (targetCrouch - this.crouchAmount) * (1 - Math.exp(-dt * 14));
    const standEye = 1.5;
    const crouchEye = 0.95;
    const eyeHeight = standEye + (crouchEye - standEye) * this.crouchAmount;
    const cy = Math.cos(state.yaw);
    const sy = Math.sin(state.yaw);
    const cp = Math.cos(state.pitch);
    const sp = Math.sin(state.pitch);

    // yaw=0 looks down -Z to match physics / standard FPS convention
    const forward = new THREE.Vector3(sy * cp, sp, -cy * cp);
    this.camera.fov += ((aiming ? 55 : 75) - this.camera.fov) * (1 - Math.exp(-dt * 16));
    this.camera.updateProjectionMatrix();

    const horizontalSpeed = Math.hypot(state.vel.x, state.vel.z);
    const targetSway =
      headSwayEnabled && state.grounded && !state.dead ? Math.min(1, horizontalSpeed / 7) : 0;
    const smoothing = 1 - Math.exp(-dt * 8);
    this.headSwayAmount += (targetSway - this.headSwayAmount) * smoothing;
    this.headSwayTime += dt * (2.2 + horizontalSpeed * 0.28);
    const swayX = Math.sin(this.headSwayTime) * 0.026 * this.headSwayAmount;
    const swayY = Math.sin(this.headSwayTime * 2 + Math.PI * 0.2) * 0.009 * this.headSwayAmount;
    const swayRoll = Math.sin(this.headSwayTime) * 0.012 * this.headSwayAmount;
    const right = new THREE.Vector3(cy, 0, sy);
    const leanTarget = state.dead ? 0 : leanInput;
    this.leanAmount += (leanTarget - this.leanAmount) * (1 - Math.exp(-dt * 12));
    const leanOffset = this.leanAmount * 0.42;
    const leanRoll = -this.leanAmount * 0.22;

    this.camera.position.set(
      state.pos.x + right.x * (swayX + leanOffset),
      state.pos.y + eyeHeight + swayY,
      state.pos.z + right.z * (swayX + leanOffset),
    );
    this.camera.lookAt(
      this.camera.position.x + forward.x,
      this.camera.position.y + forward.y,
      this.camera.position.z + forward.z,
    );
    this.camera.rotateZ(swayRoll + leanRoll);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
