interface AudioSettings {
  masterVolume: number;
  music: boolean;
  musicVolume: number;
  sfx: boolean;
  sfxVolume: number;
}

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

  playShoot() {
    this.playNoise(0.08, 0.18, 2400);
    this.playTone(95, 0.06, 0.08, "sawtooth");
  }

  playReload() {
    this.playNoise(0.12, 0.08, 1200);
    setTimeout(() => this.playTone(480, 0.04, 0.05, "square"), 90);
  }

  playHit() {
    this.playTone(70, 0.12, 0.08, "sawtooth");
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
