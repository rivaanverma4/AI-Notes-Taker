export interface AudioSegment {
  pcm: Buffer;
  startMs: number;
  endMs: number;
}

interface Frame {
  buffer: Buffer;
  startSample: number;
}

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const PRE_ROLL_FRAMES = 20; // 400 ms
const SILENCE_FRAMES_TO_END = 38; // 760 ms
const MAX_SEGMENT_SAMPLES = 20 * SAMPLE_RATE;

/**
 * A lightweight adaptive energy VAD. It keeps a pre-roll so the first syllable
 * is not clipped, and emits audio at natural pauses or after 20 seconds of
 * continuous speech. Audio is still persisted independently, so a dropped
 * word cannot cause a lost lecture.
 */
export class VadChunker {
  private pending = Buffer.alloc(0);
  private preRoll: Frame[] = [];
  private current: Frame[] = [];
  private active = false;
  private silenceFrames = 0;
  private consecutiveSpeech = 0;
  private totalSamples = 0;
  private segmentStartSample = 0;
  private noiseFloor = 0.0035;
  private disposed = false;

  constructor(private readonly onSegment: (segment: AudioSegment) => void) {}

  push(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      this.handleFrame(Buffer.from(frame));
    }
  }

  flush(): void {
    if (this.disposed) return;
    if (this.pending.length >= 2 && this.active) {
      const samples = Math.floor(this.pending.length / 2);
      const frame = Buffer.alloc(samples * 2);
      this.pending.copy(frame);
      this.current.push({ buffer: frame, startSample: this.totalSamples });
      this.totalSamples += samples;
      this.pending = Buffer.alloc(0);
    }
    if (this.active) this.emit(true);
  }

  dispose(): void {
    this.disposed = true;
    this.preRoll = [];
    this.current = [];
    this.pending = Buffer.alloc(0);
  }

  get isSpeaking(): boolean {
    return this.active;
  }

  private handleFrame(frame: Buffer): void {
    const startSample = this.totalSamples;
    this.totalSamples += FRAME_SAMPLES;

    let sum = 0;
    for (let offset = 0; offset < frame.length; offset += 2) {
      const value = frame.readInt16LE(offset) / 32768;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    const threshold = Math.max(0.0065, this.noiseFloor * 3.0);

    if (!this.active) {
      if (rms < threshold * 1.4) {
        this.noiseFloor = Math.min(
          0.05,
          Math.max(0.001, this.noiseFloor * 0.97 + rms * 0.03),
        );
      }
      this.preRoll.push({ buffer: frame, startSample });
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();

      if (rms > threshold) this.consecutiveSpeech += 1;
      else this.consecutiveSpeech = 0;

      if (this.consecutiveSpeech >= 3) {
        this.active = true;
        this.current = this.preRoll;
        this.preRoll = [];
        this.segmentStartSample = this.current[0]?.startSample ?? startSample;
        this.silenceFrames = 0;
        this.consecutiveSpeech = 0;
      }
      return;
    }

    this.current.push({ buffer: frame, startSample });
    if (rms > threshold * 0.72) this.silenceFrames = 0;
    else this.silenceFrames += 1;

    const elapsedSamples = startSample + FRAME_SAMPLES - this.segmentStartSample;
    if (this.silenceFrames >= SILENCE_FRAMES_TO_END && elapsedSamples > 4_000) {
      this.emit(true);
      return;
    }

    if (elapsedSamples >= MAX_SEGMENT_SAMPLES) {
      this.emit(false);
    }
  }

  private emit(trimTrailingSilence: boolean): void {
    if (!this.active) return;
    let frames = this.current;
    if (trimTrailingSilence && this.silenceFrames > 0) {
      const keep = 8;
      const remove = Math.max(0, this.silenceFrames - keep);
      if (frames.length - remove >= 10) {
        frames = frames.slice(0, frames.length - remove);
      }
    }

    if (frames.length >= 10) {
      const first = frames[0];
      const last = frames[frames.length - 1];
      const pcm = Buffer.concat(frames.map((frame) => frame.buffer));
      this.onSegment({
        pcm,
        startMs: Math.round((first.startSample / SAMPLE_RATE) * 1000),
        endMs: Math.round(
          ((last.startSample + last.buffer.length / 2) / SAMPLE_RATE) * 1000,
        ),
      });
    }

    this.active = false;
    this.current = [];
    this.preRoll = [];
    this.silenceFrames = 0;
    this.consecutiveSpeech = 0;
  }
}
