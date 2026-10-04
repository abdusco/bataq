// Light lounge music for the card table, synthesized locally without samples.
// Audio objects stay outside Alpine's reactive state.
export const MUSIC_TEMPO = 112;

export class GenerativeMusic {
  constructor() {
    this.context = null;
    this.playing = false;
    this.volume = 0.25;
    this.timer = null;
    this.pauseTimer = null;
    this.voices = new Set();
    this.beat = 0;
    this.motif = [];
    this.generation = 0;
  }

  setup() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return false;
    this.context = new Audio();
    const context = this.context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    this.master.connect(compressor);
    compressor.connect(context.destination);

    this.bus = context.createGain();
    this.bus.connect(this.master);
    this.pianoWave = context.createPeriodicWave(new Float32Array(6), new Float32Array([0, 1, 0.3, 0.14, 0.06, 0.025]));
    // A short, filtered echo gives the keys some air without a large reverb.
    const echo = context.createDelay(1);
    echo.delayTime.value = 60 / MUSIC_TEMPO / 2;
    const feedback = context.createGain();
    feedback.gain.value = 0.12;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    const wet = context.createGain();
    wet.gain.value = 0.1;
    this.bus.connect(echo);
    echo.connect(filter);
    filter.connect(feedback);
    feedback.connect(echo);
    filter.connect(wet);
    wet.connect(this.master);

    this.noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.12), context.sampleRate);
    const samples = this.noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    return true;
  }

  async start() {
    if (this.playing && this.context?.state === "running") return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    try {
      if (!this.context && !this.setup()) return;
      clearTimeout(this.pauseTimer);
      this.playing = true;
      // Called from a user gesture, so mobile autoplay policies can unlock it.
      await this.context.resume();
      if (!this.playing || generation !== this.generation) return;
      this.setVolume(this.volume);
      this.nextTime = this.context.currentTime + 0.06;
      this.schedule();
    } catch {
      if (generation === this.generation) this.playing = false;
    }
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (!this.context) return;
    this.master.gain.setTargetAtTime(this.playing ? this.volume * 0.65 : 0, this.context.currentTime, 0.04);
  }

  pause() {
    if (!this.context || !this.playing) return;
    this.playing = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.015);
    // Let the output fade before stopping oscillators and suspending the DSP.
    this.pauseTimer = setTimeout(() => {
      if (this.playing) return;
      for (const voice of this.voices) {
        try {
          voice.stop();
        } catch {}
      }
      this.context.suspend().catch(() => {});
    }, 80);
  }

  schedule() {
    if (!this.playing || this.context.state !== "running") return;
    // Schedule against the audio clock; delayed JS timers never pile up notes.
    if (this.nextTime < this.context.currentTime) this.nextTime = this.context.currentTime + 0.06;
    while (this.nextTime < this.context.currentTime + 0.3) {
      this.scheduleBeat(this.nextTime);
      this.nextTime += 60 / MUSIC_TEMPO;
    }
    this.timer = setTimeout(() => this.schedule(), 100);
  }

  frequency(degree) {
    const scale = [0, 2, 4, 5, 7, 9, 11];
    return this.pitch(scale[degree % 7] + 12 * Math.floor(degree / 7));
  }

  pitch(semitones) {
    return 130.81 * 2 ** (semitones / 12);
  }

  scheduleBeat(time) {
    const step = this.beat % 16;
    if (step === 0) {
      // Repeat a contour, with small changes and rests, rather than random notes.
      const contours = [
        [0, 2, 4, 2, 1, 2, 1, 0],
        [2, 4, 5, 4, 2, 1, 2, 0],
        [0, 1, 2, 4, 2, 3, 1, 0],
      ];
      this.motif = [...contours[Math.floor(Math.random() * contours.length)]];
      const change = 1 + Math.floor(Math.random() * 5);
      this.motif[change] = Math.max(0, Math.min(6, this.motif[change] + (Math.random() < 0.5 ? -1 : 1)));
    }
    // Four bars of warm seventh chords, with melody notes following the roots.
    const bar = Math.floor(step / 4);
    const roots = [0, 9, 2, 7];
    const melodyRoots = [7, 5, 8, 4];
    const chords = [
      [4, 7, 11, 14],
      [4, 7, 9, 12],
      [5, 9, 12, 16],
      [5, 7, 11, 14],
    ];
    const degree = melodyRoots[bar] + this.motif[step % 8];
    if (step % 8 === 0 || step % 8 === 7 || Math.random() > 0.18) {
      this.pluck(this.frequency(degree), time, 0.7, -0.15, 0.1);
      // Occasional swung pickup notes give phrases a little bounce.
      if (step % 4 !== 3 && Math.random() < 0.25) this.pluck(this.frequency(degree + 1), time + ((60 / MUSIC_TEMPO) * 2) / 3, 0.35, -0.15, 0.055);
    }
    if (step % 4 === 0 || step % 4 === 2) {
      const offset = step % 4 === 2 ? 60 / MUSIC_TEMPO / 2 : 0;
      for (const [index, semitones] of chords[bar].entries()) this.pluck(this.pitch(semitones), time + offset + index * 0.012, 0.9, 0.2, 0.035);
      this.bass(this.pitch(roots[bar] - 12 + (step % 4 === 2 ? 7 : 0)), time);
    }
    if (step % 4 === 0) this.drum(time, false);
    if (step % 4 === 1 || step % 4 === 3) this.drum(time, true);
    this.beat++;
  }

  track(source, nodes, time, duration) {
    this.voices.add(source);
    source.onended = () => {
      this.voices.delete(source);
      source.disconnect();
      for (const node of nodes) node.disconnect();
    };
    source.start(time);
    source.stop(time + duration);
  }

  pluck(frequency, time, duration, pan, level) {
    const context = this.context;
    const note = context.createOscillator();
    note.setPeriodicWave(this.pianoWave);
    note.frequency.value = frequency;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(frequency * 7, time);
    filter.frequency.exponentialRampToValueAtTime(frequency * 1.5, time + duration * 0.6);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(level, time + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    note.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(this.bus);
    this.track(note, [filter, envelope, panner], time, duration);
  }

  bass(frequency, time) {
    const note = this.context.createOscillator();
    note.type = "sine";
    note.frequency.value = frequency;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(0.14, time + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.65);
    note.connect(envelope);
    envelope.connect(this.bus);
    this.track(note, [envelope], time, 0.65);
  }

  drum(time, high) {
    const context = this.context;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(high ? 0.035 : 0.055, time + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    envelope.connect(this.bus);
    if (high) {
      const tick = context.createBufferSource();
      tick.buffer = this.noise;
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1800;
      filter.Q.value = 0.5;
      tick.connect(filter);
      filter.connect(envelope);
      this.track(tick, [filter, envelope], time, 0.12);
    } else {
      const note = context.createOscillator();
      note.frequency.setValueAtTime(135, time);
      note.frequency.exponentialRampToValueAtTime(58, time + 0.12);
      note.connect(envelope);
      this.track(note, [envelope], time, 0.17);
    }
  }
}
