/* Runs on the audio thread. Each message is 80 ms of mono 16 kHz PCM,
   continuously resampled from the device's actual sample rate. */
class SaathiMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.sum = 0;
    this.weight = 0;
    this.frame = new Int16Array(1280);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      let left = 1;
      while (left > 0.000001) {
        const portion = Math.min(left, this.ratio - this.weight);
        this.sum += value * portion;
        this.weight += portion;
        left -= portion;
        if (this.weight >= this.ratio - 0.000001) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
          this.sum = 0;
          this.weight = 0;
          if (this.offset === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(1280);
            this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("saathi-microphone", SaathiMicrophone);
