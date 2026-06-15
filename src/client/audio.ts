interface AudioSettings {
  masterVolume: number;
  music: boolean;
  musicVolume: number;
  sfx: boolean;
  sfxVolume: number;
}

type WeaponAudioId = "pistol" | "rifle" | "sniper" | "shotgun";

export class AudioManager {
  ctx = new AudioContext();
  masterGain = this.ctx.createGain();
  sfxGain = this.ctx.createGain();
  musicGain = this.ctx.createGain();
  lastFootstepAt = 0;
  musicTimer = 0;
  musicStep = 0;
  padHum: { osc: OscillatorNode; gain: GainNode } | null = null;

  constructor() {
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = 0.8;
    this.sfxGain.gain.value = 1;
    this.musicGain.gain.value = 0.35;
  }

  async resume() {
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  applySettings(settings: AudioSettings) {
    this.masterGain.gain.value = settings.masterVolume;
    this.sfxGain.gain.value = settings.sfx ? settings.sfxVolume : 0;
    this.musicGain.gain.value = settings.music ? settings.musicVolume : 0;
    this.setMusicEnabled(settings.music);
  }

  playTone(freq: number, duration: number, gainValue: number, type: OscillatorType = "sine") {
    void this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + duration);
  }

  playMusicTone(freq: number, duration: number, gainValue: number, type: OscillatorType = "sine") {
    void this.resume();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(type === "sawtooth" ? 520 : 1800, now);
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(filter).connect(gain).connect(this.musicGain);
    osc.start(now);
    osc.stop(now + duration);
  }

  playNoise(duration: number, gainValue: number, filterFreq: number) {
    this.playNoiseTo(this.sfxGain, duration, gainValue, filterFreq);
  }

  playMusicNoise(duration: number, gainValue: number, filterFreq: number) {
    this.playNoiseTo(this.musicGain, duration, gainValue, filterFreq);
  }

  playNoiseTo(output: AudioNode, duration: number, gainValue: number, filterFreq: number) {
    void this.resume();
    const sampleCount = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;
    gain.gain.value = gainValue;
    source.connect(filter).connect(gain).connect(output);
    source.start();
  }

  playFootstep() {
    const now = performance.now();
    if (now - this.lastFootstepAt < 280) return;
    this.lastFootstepAt = now;
    this.playNoise(0.045, 0.08, 450);
    this.playTone(90, 0.045, 0.03, "triangle");
  }

  playJump() {
    this.playTone(180, 0.09, 0.08, "triangle");
  }

  randomOf<T>(variants: T[]): T {
    return variants[Math.floor(Math.random() * variants.length)] ?? variants[0];
  }

  playShoot(weaponId: string = "pistol") {
    const weapon = weaponId as WeaponAudioId;
    if (weapon === "rifle") {
      const variant = this.randomOf([
        () => {
          this.playNoise(0.055, 0.14, 2900);
          this.playTone(128, 0.045, 0.06, "square");
          setTimeout(() => this.playTone(210, 0.025, 0.03, "triangle"), 14);
        },
        () => {
          this.playNoise(0.05, 0.13, 3200);
          this.playTone(142, 0.05, 0.055, "sawtooth");
          setTimeout(() => this.playNoise(0.018, 0.05, 5400), 18);
        },
        () => {
          this.playNoise(0.06, 0.12, 2600);
          this.playTone(118, 0.04, 0.065, "square");
        },
      ]);
      variant();
      return;
    }
    if (weapon === "sniper") {
      const variant = this.randomOf([
        () => {
          this.playNoise(0.12, 0.22, 1800);
          this.playTone(78, 0.09, 0.11, "sawtooth");
          setTimeout(() => this.playTone(42, 0.08, 0.08, "triangle"), 24);
        },
        () => {
          this.playNoise(0.1, 0.2, 1500);
          this.playTone(84, 0.1, 0.1, "square");
          setTimeout(() => this.playNoise(0.03, 0.05, 4200), 30);
        },
      ]);
      variant();
      return;
    }
    if (weapon === "shotgun") {
      const variant = this.randomOf([
        () => {
          this.playNoise(0.13, 0.28, 1700);
          this.playTone(70, 0.075, 0.11, "square");
          setTimeout(() => this.playNoise(0.035, 0.09, 900), 20);
        },
        () => {
          this.playNoise(0.12, 0.26, 1500);
          this.playTone(62, 0.08, 0.12, "sawtooth");
          setTimeout(() => this.playTone(96, 0.035, 0.04, "triangle"), 16);
        },
        () => {
          this.playNoise(0.11, 0.24, 1400);
          this.playTone(68, 0.085, 0.1, "square");
        },
      ]);
      variant();
      return;
    }

    const variant = this.randomOf([
      () => {
        this.playNoise(0.07, 0.14, 2600);
        this.playTone(105, 0.05, 0.07, "sawtooth");
      },
      () => {
        this.playNoise(0.06, 0.13, 3000);
        this.playTone(120, 0.04, 0.06, "square");
        setTimeout(() => this.playTone(180, 0.02, 0.025, "triangle"), 12);
      },
      () => {
        this.playNoise(0.065, 0.12, 2400);
        this.playTone(92, 0.055, 0.065, "sawtooth");
      },
    ]);
    variant();
  }

  playReload(weaponId: string = "pistol") {
    const weapon = weaponId as WeaponAudioId;
    if (weapon === "rifle") {
      // Mag out -> mag in -> bolt slap
      this.playNoise(0.06, 0.09, 1600);
      setTimeout(() => this.playNoise(0.05, 0.1, 1400), 120);
      setTimeout(() => this.playTone(340, 0.045, 0.05, "square"), 140);
      setTimeout(() => {
        this.playNoise(0.07, 0.12, 2200);
        this.playTone(520, 0.035, 0.05, "sawtooth");
      }, 420);
      setTimeout(() => this.playNoise(0.05, 0.08, 2600), 620);
      setTimeout(() => this.playTone(610, 0.025, 0.035, "square"), 820);
      return;
    }
    if (weapon === "sniper") {
      // Bolt open -> round chamber -> bolt close
      this.playNoise(0.08, 0.09, 1100);
      setTimeout(() => this.playTone(220, 0.05, 0.04, "square"), 140);
      setTimeout(() => {
        this.playNoise(0.06, 0.08, 900);
        this.playTone(260, 0.045, 0.035, "triangle");
      }, 380);
      setTimeout(() => {
        this.playNoise(0.09, 0.12, 1800);
        this.playTone(180, 0.06, 0.05, "sawtooth");
      }, 720);
      setTimeout(() => this.playNoise(0.05, 0.07, 2400), 980);
      return;
    }
    if (weapon === "shotgun") {
      // Pump -> shell clatter -> pump home
      this.playNoise(0.08, 0.11, 900);
      setTimeout(() => this.playTone(150, 0.055, 0.05, "square"), 80);
      setTimeout(() => {
        this.playNoise(0.06, 0.08, 600);
        this.playTone(240, 0.04, 0.035, "triangle");
      }, 260);
      setTimeout(() => {
        this.playNoise(0.1, 0.13, 1400);
        this.playTone(120, 0.07, 0.06, "sawtooth");
      }, 700);
      setTimeout(() => this.playNoise(0.06, 0.09, 1100), 950);
      return;
    }

    // Pistol: mag drop -> mag seat -> slide release
    this.playNoise(0.07, 0.09, 1300);
    setTimeout(() => this.playTone(420, 0.035, 0.04, "square"), 80);
    setTimeout(() => {
      this.playNoise(0.06, 0.1, 1500);
      this.playTone(380, 0.04, 0.045, "triangle");
    }, 220);
    setTimeout(() => {
      this.playNoise(0.08, 0.12, 2400);
      this.playTone(520, 0.045, 0.05, "sawtooth");
    }, 520);
    setTimeout(() => this.playNoise(0.05, 0.07, 2600), 680);
  }

  playHit() {
    this.playTone(70, 0.12, 0.08, "sawtooth");
  }

  playHitMarker() {
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(1800, now + 0.05);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  playKillConfirm() {
    const now = this.ctx.currentTime;
    const playBell = (freq: number, delay: number, duration: number, gain: number) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + delay);
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(gain, now + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);
      osc.connect(g).connect(this.sfxGain);
      osc.start(now + delay);
      osc.stop(now + delay + duration);
    };
    playBell(880, 0, 0.14, 0.12);
    playBell(1109, 0.06, 0.16, 0.09);
    playBell(1319, 0.12, 0.2, 0.08);
  }

  playJumpPad() {
    const variants = [
      [260, 520, 920],
      [220, 440, 780],
      [310, 620, 1040],
      [180, 390, 700],
    ];
    const notes = variants[Math.floor(Math.random() * variants.length)];
    notes.forEach((freq, i) =>
      setTimeout(() => this.playTone(freq, 0.08, 0.075, "triangle"), i * 34),
    );
    this.playNoise(0.06, 0.05, 1800);
  }

  startPadHum() {
    if (this.padHum) return;
    void this.resume();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.value = 72;
    filter.type = "lowpass";
    filter.frequency.value = 240;
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(this.sfxGain);
    osc.start();
    this.padHum = { osc, gain };
  }

  setPadHumIntensity(intensity: number) {
    if (!this.padHum) return;
    const target = Math.max(0, Math.min(1, intensity)) * 0.045;
    this.padHum.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
  }

  setMusicEnabled(enabled: boolean) {
    if (enabled && !this.musicTimer) {
      void this.resume();
      this.musicTimer = setInterval(() => this.playMusicStep(), 150);
    } else if (!enabled && this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = 0;
      this.musicStep = 0;
    }
  }

  playMusicStep() {
    const bass = [
      55, 0, 55, 82, 0, 55, 98, 0, 55, 0, 110, 98, 0, 82, 55, 0, 49, 0, 49, 73, 0, 49, 87, 0, 49, 0,
      98, 87, 0, 73, 49, 0, 41, 0, 41, 62, 0, 41, 82, 0, 41, 0, 92, 82, 0, 62, 41, 0, 55, 0, 55, 82,
      0, 65, 98, 0, 73, 0, 110, 98, 82, 73, 65, 0,
    ];
    const lead = [
      0, 220, 0, 0, 247, 0, 196, 0, 0, 165, 0, 196, 0, 247, 0, 0, 0, 196, 0, 0, 220, 0, 165, 0, 0,
      147, 0, 165, 0, 220, 0, 0, 0, 165, 0, 0, 196, 0, 147, 0, 0, 123, 0, 147, 0, 196, 0, 0, 0, 220,
      0, 247, 0, 294, 0, 247, 0, 220, 0, 196, 0, 165, 0, 0,
    ];
    const i = this.musicStep++ % bass.length;
    if (bass[i]) this.playMusicTone(bass[i], 0.13, 0.12, "sawtooth");
    if (lead[i]) this.playMusicTone(lead[i], 0.08, 0.055, "square");
    if (i % 4 === 0) this.playMusicNoise(0.028, 0.045, 520);
    if (i % 8 === 4) this.playMusicNoise(0.02, 0.025, 2200);
  }
}
