/**
 * Audio Playback Worklet Processor for playing PCM audio
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioQueue = [];
    this.isActive = false;

    this.port.onmessage = (event) => {
      if (event.data === "interrupt") {
        // Clear the queue on interrupt
        this.audioQueue = [];
        if (this.isActive) {
          this.isActive = false;
          this.port.postMessage({ type: "idle", reason: "interrupt" });
        }
      } else if (event.data instanceof Float32Array) {
        // Add audio data to the queue
        this.audioQueue.push(event.data);
        if (!this.isActive) {
          this.isActive = true;
          this.port.postMessage({ type: "active" });
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (output.length === 0) return true;

    const channel = output[0];
    let outputIndex = 0;

    // Fill the output buffer from the queue
    while (outputIndex < channel.length && this.audioQueue.length > 0) {
      const currentBuffer = this.audioQueue[0];

      if (!currentBuffer || currentBuffer.length === 0) {
        this.audioQueue.shift();
        continue;
      }

      const remainingOutput = channel.length - outputIndex;
      const remainingBuffer = currentBuffer.length;
      const copyLength = Math.min(remainingOutput, remainingBuffer);

      // Copy audio data to output
      for (let i = 0; i < copyLength; i++) {
        channel[outputIndex++] = currentBuffer[i];
      }

      // Update or remove the current buffer
      if (copyLength < remainingBuffer) {
        this.audioQueue[0] = currentBuffer.slice(copyLength);
      } else {
        this.audioQueue.shift();
      }
    }

    // Fill remaining output with silence
    while (outputIndex < channel.length) {
      channel[outputIndex++] = 0;
    }

    // Notify main thread when playback becomes idle (queue drained).
    if (this.isActive && this.audioQueue.length === 0) {
      this.isActive = false;
      this.port.postMessage({ type: "idle", reason: "drain" });
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
