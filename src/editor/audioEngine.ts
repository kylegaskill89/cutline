/**
 * Multi-track audio playback via the Web Audio API.
 *
 * The <video> elements play muted (picture only). All audio is decoded per
 * (media, stream) into AudioBuffers and, on play, every audio clip from the
 * playhead onward is scheduled as an AudioBufferSourceNode → per-clip GainNode
 * → master, so all tracks are heard at once, gapless and sample-synced, with
 * live per-clip volume. The audio clock also serves as the master timeline
 * clock while playing (more stable than the system clock for A/V sync).
 */
import { extractAudioBuffer } from "../tauri/sidecar.ts";
import {
  clipEnd,
  clipGain,
  clipDuration,
  clipFadeIn,
  clipFadeOut,
  clipSpeed,
  clipReversed,
  clipEnabled,
  isTrackAudible,
  type Project,
  type Clip,
} from "../core/project.ts";

interface ActiveNode {
  clipId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private reversed = new Map<string, AudioBuffer>();
  private processed = new Map<string, AudioBuffer>(); // reverse/speed-baked, cached
  private loading = new Map<string, Promise<void>>();
  private active: ActiveNode[] = [];
  private anchorCtx = 0;
  private anchorT = 0;
  playing = false;

  private analyser: AnalyserNode | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(this.analyser); // tap for the level meter
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Current output peak level in 0..1 (for a VU meter). */
  getLevel(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    return Math.min(1, peak);
  }

  private key(mediaId: string, stream: number): string {
    return `${mediaId}:${stream}`;
  }

  setMasterVolume(v: number) {
    this.ensureCtx();
    this.master!.gain.value = v;
  }

  /** Decode and cache a track's audio; safe to call repeatedly. */
  loadTrack(mediaId: string, path: string, stream: number): Promise<void> {
    const k = this.key(mediaId, stream);
    if (this.buffers.has(k)) return Promise.resolve();
    const existing = this.loading.get(k);
    if (existing) return existing;
    const ctx = this.ensureCtx();
    const p = extractAudioBuffer(path, stream)
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audio) => {
        this.buffers.set(k, audio);
        this.loading.delete(k);
      })
      .catch(() => {
        this.loading.delete(k);
      });
    this.loading.set(k, p);
    return p;
  }

  /**
   * A decoded buffer with reverse and/or speed baked in, played at rate 1.
   * Speed uses a pitch-preserving overlap-add time-stretch, so slow/fast clips
   * keep their original pitch (like the export's atempo). Cached per key/params.
   */
  private processedBuffer(
    key: string,
    buf: AudioBuffer,
    reverse: boolean,
    speed: number,
  ): AudioBuffer {
    if (!reverse && speed === 1) return buf;
    const ck = `${key}:${reverse ? "r" : "f"}:${speed}`;
    const cached = this.processed.get(ck);
    if (cached) return cached;
    const base = reverse ? this.reversedBuffer(key, buf) : buf;
    const result = speed === 1 ? base : this.timeStretch(base, speed);
    this.processed.set(ck, result);
    return result;
  }

  /**
   * Pitch-preserving time-stretch by overlap-add (WSOLA-lite). Produces a buffer
   * `speed`× shorter (fast) or longer (slow) than the input, at the same sample
   * rate and pitch. Windowed grains are taken at an analysis hop of `Hs*speed`
   * and laid down at a fixed synthesis hop, normalised by the summed window.
   */
  private timeStretch(input: AudioBuffer, speed: number): AudioBuffer {
    const ctx = this.ensureCtx();
    const sr = input.sampleRate;
    const N = 2048; // window size
    const Hs = N >> 2; // synthesis hop (75% overlap)
    const Ha = Math.max(1, Math.round(Hs * speed)); // analysis hop
    const inLen = input.length;
    const outLen = Math.max(1, Math.floor(inLen / speed));
    const out = ctx.createBuffer(input.numberOfChannels, outLen, sr);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    for (let ch = 0; ch < input.numberOfChannels; ch++) {
      const inp = input.getChannelData(ch);
      const outp = out.getChannelData(ch);
      const norm = new Float32Array(outLen);
      let ana = 0;
      let syn = 0;
      while (syn < outLen && ana + N <= inLen) {
        const lim = Math.min(N, outLen - syn);
        for (let i = 0; i < lim; i++) {
          const w = win[i];
          outp[syn + i] += inp[ana + i] * w;
          norm[syn + i] += w;
        }
        ana += Ha;
        syn += Hs;
      }
      for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) outp[i] /= norm[i];
    }
    return out;
  }

  /** A time-reversed copy of a decoded buffer (cached) for reversed clips. */
  private reversedBuffer(key: string, buf: AudioBuffer): AudioBuffer {
    const cached = this.reversed.get(key);
    if (cached) return cached;
    const ctx = this.ensureCtx();
    const rb = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = rb.getChannelData(ch);
      const n = src.length;
      for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i];
    }
    this.reversed.set(key, rb);
    return rb;
  }

  get currentTime(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Master timeline time derived from the audio clock while playing. */
  timeNow(): number {
    return this.anchorT + (this.currentTime - this.anchorCtx);
  }

  async resume(): Promise<void> {
    await this.ensureCtx().resume();
  }

  /** Schedule every decoded audio clip from timeline time `t0` to the end. */
  start(project: Project, t0: number) {
    const ctx = this.ensureCtx();
    this.stop();
    const now = ctx.currentTime + 0.03; // small lead so starts land in the future
    this.anchorCtx = now;
    this.anchorT = t0;

    for (const track of project.tracks) {
      if (track.kind !== "audio") continue;
      if (!isTrackAudible(project, track)) continue; // muted / not soloed
      for (const clip of track.clips) {
        if (clip.audioStream === undefined || !clipEnabled(clip)) continue;
        const buffer = this.buffers.get(this.key(clip.mediaId, clip.audioStream));
        if (!buffer) continue; // not decoded yet — silent this pass
        const end = clipEnd(clip);
        if (end <= t0) continue; // already past

        const startTL = Math.max(clip.start, t0);
        const when = now + (startTL - t0);
        const spd = clipSpeed(clip);
        const rev = clipReversed(clip);
        const dur = end - startTL; // timeline seconds remaining for this clip
        if (dur <= 0) continue;

        // Reverse and speed are baked into a processed buffer that plays at
        // rate 1, so speed changes duration WITHOUT shifting pitch (a pitch-
        // preserving time-stretch, matching the ffmpeg atempo export path).
        const key = this.key(clip.mediaId, clip.audioStream);
        const playBuffer = this.processedBuffer(key, buffer, rev, spd);
        // The processed buffer's timeline is 1:1 with the sequence. Read offset
        // at the clip's own start, then advance by real elapsed time.
        const mediaDur = buffer.duration;
        const processedStart = (rev ? mediaDur - clip.sourceOut : clip.sourceIn) / spd;
        const offset = processedStart + (startTL - clip.start);
        if (offset >= playBuffer.duration) continue;

        const source = ctx.createBufferSource();
        source.buffer = playBuffer;
        const gain = ctx.createGain();
        const g = clipGain(clip);
        this.scheduleGainEnvelope(gain, clip, g, when, startTL - clip.start);
        source.connect(gain).connect(this.master!);
        try {
          source.start(when, offset, Math.min(dur, playBuffer.duration - offset));
        } catch {
          /* ignore scheduling races */
        }
        this.active.push({ clipId: clip.id, source, gain });
      }
    }
    this.playing = true;
  }

  /**
   * Schedules a clip's fade-in/out gain envelope on its GainNode. `when` is the
   * ctx time playback begins; `localAtWhen` is how far into the clip that is
   * (>0 when starting mid-clip after a seek).
   */
  private scheduleGainEnvelope(
    gain: GainNode,
    clip: Clip,
    g: number,
    when: number,
    localAtWhen: number,
  ) {
    const fi = clipFadeIn(clip);
    const fo = clipFadeOut(clip);
    const len = clipDuration(clip);
    if (fi <= 0 && fo <= 0) {
      gain.gain.setValueAtTime(g, when);
      return;
    }
    const envAt = (local: number): number => {
      let v = g;
      if (fi > 0 && local < fi) v = g * (local / fi);
      const tail = len - local;
      if (fo > 0 && tail < fo) v = Math.min(v, g * (tail / fo));
      return Math.max(0, v);
    };
    gain.gain.setValueAtTime(envAt(localAtWhen), when);
    if (fi > 0 && localAtWhen < fi) {
      gain.gain.linearRampToValueAtTime(g, when + (fi - localAtWhen));
    }
    if (fo > 0) {
      const foStart = len - fo;
      if (foStart > localAtWhen) gain.gain.setValueAtTime(g, when + (foStart - localAtWhen));
      gain.gain.linearRampToValueAtTime(0, when + (len - localAtWhen));
    }
  }

  stop() {
    for (const n of this.active) {
      try {
        n.source.stop();
      } catch {
        /* already stopped */
      }
      n.source.disconnect();
      n.gain.disconnect();
    }
    this.active = [];
    this.playing = false;
  }

  /** Live-adjust a clip's gain while playing (from the volume rubber-band). */
  setClipGainLive(clipId: string, gain: number) {
    for (const n of this.active) {
      if (n.clipId === clipId) n.gain.gain.value = gain;
    }
  }
}
