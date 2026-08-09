// Energy-based voice activity detection.
//
// This only drives the mic status dot (speaking / not speaking) — actual
// silence-vs-speech decisions for transcription are the Speech framework's own
// job, made from the full audio, not this coarse RMS gate.
//
// The core idea is standard DSP: compare short-frame loudness against a floor
// that tracks the room's background noise, and require loudness to persist for
// a few frames before flipping state either direction. Two thresholds (higher
// to start, lower to stop) give the flip some hysteresis so it doesn't chatter
// right at the boundary.

const SAMPLE_RATE = 16000;
const FRAME_MS = 30;
const FRAME_SAMPLES = Math.floor(SAMPLE_RATE * FRAME_MS / 1000);
const BYTES_PER_FRAME = FRAME_SAMPLES * 2; // Int16LE

class AdaptiveVAD {
  constructor(opts = {}) {
    this.onStart = opts.onSpeechStart || (() => {});
    this.onEnd = opts.onSpeechEnd || (() => {});

    this.onsetLevel = opts.onsetThreshold ?? 220;
    this.offsetLevel = opts.offsetThreshold ?? 130;
    this.holdFrames = opts.silenceFrames ?? 16;     // frames of quiet before declaring speech over
    this.minSpeechFrames = opts.minSpeechFrames ?? 4; // frames of loud before it counted as speech at all

    this._floor = 90;         // running estimate of background noise level
    this._floorGain = 0.02;   // how quickly the floor adapts (per silent frame)
    this._floorCeiling = 400; // never let a burst of noise drag the floor up

    this._speaking = false;
    this._loudRun = 0;   // consecutive frames above onset, while speaking
    this._quietRun = 0;  // consecutive frames below offset, while speaking
  }

  processChunk(pcm) {
    for (let offset = 0; offset + BYTES_PER_FRAME <= pcm.length; offset += BYTES_PER_FRAME) {
      this._processFrame(rmsInt16LE(pcm, offset, FRAME_SAMPLES));
    }
  }

  _processFrame(level) {
    if (!this._speaking && level < this._floorCeiling) {
      this._floor += (level - this._floor) * this._floorGain;
    }

    const startsAt = Math.max(this.onsetLevel, this._floor * 2.5);
    const stopsAt = Math.max(this.offsetLevel, this._floor * 1.5);

    if (!this._speaking) {
      this._loudRun = level > startsAt ? this._loudRun + 1 : 0;
      if (this._loudRun >= this.minSpeechFrames) {
        this._speaking = true;
        this._quietRun = 0;
        this.onStart();
      }
      return;
    }

    if (level < stopsAt) {
      this._quietRun++;
      if (this._quietRun >= this.holdFrames) {
        this._speaking = false;
        this.onEnd(this._quietRun * FRAME_MS); // duration is approximate, callers only log it
      }
    } else {
      this._quietRun = 0;
    }
  }

  reset() {
    this._speaking = false;
    this._loudRun = 0;
    this._quietRun = 0;
    this._floor = 90;
  }
}

function rmsInt16LE(buf, start, sampleCount) {
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(start + i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

module.exports = { AdaptiveVAD };
