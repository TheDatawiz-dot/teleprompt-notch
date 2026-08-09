// AudioWorklet processor: converts the mic's Float32 samples to Int16 PCM off
// the main thread and hands fixed-size chunks to the renderer over the port.
//
// Unlike a ScriptProcessorNode (deprecated, runs on the main thread), an
// AudioWorkletProcessor runs on the audio rendering thread, so this stays real
// -time even while the window is busy painting or scrolling.

const CHUNK_SAMPLES = 4096; // ~256ms at 16kHz — matches what the transcriber expects per write

class NotchPromptAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunk = new Int16Array(CHUNK_SAMPLES);
    this._filled = 0;
  }

  // Converts one Float32 sample in [-1, 1] to Int16 PCM range. Float32 audio
  // can technically clip past ±1 (e.g. summed inputs), so the input is clamped
  // first — an unclamped multiply would wrap around instead of saturating.
  static toInt16(sample) {
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // no input connected yet — keep the node alive

    for (let i = 0; i < channel.length; i++) {
      this._chunk[this._filled++] = NotchPromptAudioProcessor.toInt16(channel[i]);
      if (this._filled === CHUNK_SAMPLES) this._send();
    }
    return true;
  }

  _send() {
    this.port.postMessage(this._chunk.buffer, [this._chunk.buffer]);
    this._chunk = new Int16Array(CHUNK_SAMPLES); // the old buffer was transferred, not copied
    this._filled = 0;
  }
}

registerProcessor('notchprompt-audio-processor', NotchPromptAudioProcessor);
