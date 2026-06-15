import { PlayerInput, WEAPONS } from "../shared/protocol.ts";

export class InputManager {
  keys = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  yaw = 0;
  pitch = 0;
  jumpQueued = false;
  reloadQueued = false;
  fireQueued = false;
  fireHeld = false;
  currentWeaponIndex = 0;
  pointerLocked = false;
  lean = 0;
  aiming = false;

  constructor() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") this.jumpQueued = true;
      if (e.code === "KeyR") this.reloadQueued = true;
      if (e.code === "Digit1") this.currentWeaponIndex = 0;
      if (e.code === "Digit2") this.currentWeaponIndex = 1;
      if (e.code === "Digit3") this.currentWeaponIndex = 2;
      if (e.code === "Digit4") this.currentWeaponIndex = 3;
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.mouseX += e.movementX;
      this.mouseY += e.movementY;
    });

    document.addEventListener("mousedown", (e) => {
      if (e.button === 0) {
        this.fireQueued = true;
        this.fireHeld = true;
      }
      if (e.button === 2) this.aiming = true;
    });

    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.aiming = false;
    });

    document.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement | null)?.id === "game") e.preventDefault();
    });

    document.addEventListener(
      "wheel",
      (e) => {
        if (!this.pointerLocked) return;
        if (e.deltaY < 0) {
          this.currentWeaponIndex = (this.currentWeaponIndex + 1) % 4;
        } else if (e.deltaY > 0) {
          this.currentWeaponIndex = (this.currentWeaponIndex + 4 - 1) % 4;
        }
      },
      { passive: true },
    );

    document.addEventListener("click", (e) => {
      if ((e.target as HTMLElement | null)?.id !== "game") return;
      document.body.requestPointerLock?.();
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === document.body;
    });
  }

  sample(seq: number): PlayerInput {
    this.lean = (this.keys.has("KeyE") ? 1 : 0) - (this.keys.has("KeyQ") ? 1 : 0);

    const sensitivity = 0.002;
    this.yaw += this.mouseX * sensitivity;
    this.pitch -= this.mouseY * sensitivity;
    this.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.pitch));
    this.mouseX = 0;
    this.mouseY = 0;

    const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const right = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const crouch =
      this.keys.has("ControlLeft") || this.keys.has("ControlRight") || this.keys.has("KeyC");
    const jump = this.jumpQueued;
    const reload = this.reloadQueued;
    this.jumpQueued = false;
    this.reloadQueued = false;

    const weapon = WEAPONS[this.currentWeaponIndex] ?? WEAPONS[0];
    const fire = this.fireQueued || (this.fireHeld && weapon.automatic === true);
    this.fireQueued = false;

    return {
      seq,
      forward,
      right,
      jump,
      crouch,
      aiming: this.aiming,
      fire,
      reload,
      weaponIndex: this.currentWeaponIndex,
      lookYaw: this.yaw,
      lookPitch: this.pitch,
    };
  }
}
