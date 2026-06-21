export const SETTINGS = {
  net: {
    tickRate: 60,
    snapshotRate: 20,
    maxInputHistory: 180,
    maxSnapshotHistory: 8,
  },
  reconciliation: {
    softThresholdMeters: 10.0,
    hardThresholdMeters: 50.0,
    visualCorrectionDecay: 2,
  },
  player: {
    speed: 8,
    jumpSpeed: 12,
    gravity: 28,
    radius: 0.4,
    height: 1.6,
    crouchHeight: 1.0,
    eyeHeight: 1.5,
    crouchEyeHeight: 0.95,
    crouchSpeedMultiplier: 0.55,
    groundFriction: 0.85,
    airFriction: 0.98,
    maxStepHeight: 0.95,
  },
  combat: {
    respawnMs: 5000,
    fireMaxDistance: 200,
  },
  weaponVisuals: {
    handHeight: 1.02,
    rightHandOffset: 0.48,
    forwardHandOffset: 0.702,
    muzzleForwardOffset: 0.55,
    muzzleUpOffset: 0.02,
  },
} as const;
