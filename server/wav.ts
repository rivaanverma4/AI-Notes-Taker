import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const HEADER_BYTES = 44;

export function createWavHeader(
  dataBytes: number,
  sampleRate = 16_000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function pcmToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  return Buffer.concat([createWavHeader(pcm.length, sampleRate), pcm]);
}

export class WavWriter {
  private fd: number;
  private dataBytes = 0;
  private closed = false;

  constructor(
    public readonly filePath: string,
    private readonly sampleRate = 16_000,
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = openSync(filePath, "w");
    writeSync(this.fd, createWavHeader(0, sampleRate));
  }

  append(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }

  get durationMs(): number {
    return Math.round((this.dataBytes / 2 / this.sampleRate) * 1000);
  }

  finalize(): void {
    if (this.closed) return;
    const header = createWavHeader(this.dataBytes, this.sampleRate);
    writeSync(this.fd, header, 0, header.length, 0);
    try {
      fsyncSync(this.fd);
    } catch {
      // fsync is best-effort; the file is still valid.
    }
    closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * Repairs a WAV file whose header was not finalized because the process exited.
 * Returns the repaired duration in milliseconds.
 */
export function repairWavHeader(filePath: string, sampleRate = 16_000): number {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r+");
    const size = fstatSync(fd).size;
    const dataBytes = Math.max(0, size - HEADER_BYTES);
    const header = createWavHeader(dataBytes, sampleRate);
    writeSync(fd, header, 0, header.length, 0);
    fsyncSync(fd);
    return Math.round((dataBytes / 2 / sampleRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore.
      }
    }
  }
}
