class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate ?? 16000;
    this.chunkSamples = options.processorOptions?.chunkSamples ?? 1600;
    this.samples = new Int16Array(this.chunkSamples);
    this.offset = 0;
    this.phase = 0;
    this.levelSum = 0;
    this.levelCount = 0;
    this.chunksSinceLevel = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] ?? 0;
      value /= channels.length;
      this.levelSum += value * value;
      this.levelCount += 1;

      this.phase += this.targetSampleRate;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const clamped = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      if (this.offset !== this.chunkSamples) continue;

      const buffer = this.samples.buffer;
      this.port.postMessage({ type: 'chunk', buffer }, [buffer]);
      this.samples = new Int16Array(this.chunkSamples);
      this.offset = 0;
      this.chunksSinceLevel += 1;
      if (this.chunksSinceLevel >= 5) {
        const rms = Math.sqrt(this.levelSum / Math.max(1, this.levelCount));
        this.port.postMessage({ type: 'level', value: Math.min(1, rms * 4) });
        this.levelSum = 0;
        this.levelCount = 0;
        this.chunksSinceLevel = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm16-processor', Pcm16Processor);
