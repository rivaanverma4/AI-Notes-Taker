class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions ?? {};
    this.targetRate = processorOptions.targetRate ?? 16000;
    this.ratio = sampleRate / this.targetRate;
    this.input = new Float32Array(8192);
    this.inputLength = 0;
    this.readPosition = 0;
    this.output = new Int16Array(Math.round(this.targetRate * 0.1));
    this.outputLength = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush();
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    if (this.inputLength + channel.length > this.input.length) {
      const next = new Float32Array(
        Math.max(this.input.length * 2, this.inputLength + channel.length),
      );
      next.set(this.input.subarray(0, this.inputLength));
      this.input = next;
    }
    this.input.set(channel, this.inputLength);
    this.inputLength += channel.length;

    while (this.readPosition + 1 < this.inputLength) {
      const index = Math.floor(this.readPosition);
      const fraction = this.readPosition - index;
      const sample =
        this.input[index] * (1 - fraction) + this.input[index + 1] * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.output[this.outputLength++] = clamped * 32767;
      this.readPosition += this.ratio;
      if (this.outputLength === this.output.length) this.flush();
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.input.copyWithin(0, consumed, this.inputLength);
      this.inputLength -= consumed;
      this.readPosition -= consumed;
    }
    return true;
  }

  flush() {
    if (this.outputLength === 0) return;
    const chunk = this.output.slice(0, this.outputLength);
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.outputLength = 0;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
