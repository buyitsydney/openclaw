/**
 * Media Utilities - Audio and Video streaming helpers for Gemini Live API
 * Handles media capture, processing, and playback
 */

/**
 * Audio Streamer - Captures and streams microphone audio
 */
class AudioStreamer {
  constructor(geminiClient) {
    this.client = geminiClient;
    this.audioContext = null;
    this.audioWorklet = null;
    this.mediaStream = null;
    this.isStreaming = false;
    this.sampleRate = 16000; // Gemini requires 16kHz
  }

  /**
   * Start streaming audio from microphone
   * @param {string} deviceId - Optional device ID for specific microphone
   */
  async start(deviceId = null) {
    try {
      // Build audio constraints
      const audioConstraints = {
        sampleRate: this.sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };

      // Add device ID if specified
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      // Create audio context at 16kHz
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)({
        sampleRate: this.sampleRate,
      });

      // Load the audio worklet module
      await this.audioContext.audioWorklet.addModule(
        "audio-processors/capture.worklet.js"
      );

      // Create the audio worklet node
      this.audioWorklet = new AudioWorkletNode(
        this.audioContext,
        "audio-capture-processor"
      );

      // Set up message handling from the worklet
      this.audioWorklet.port.onmessage = (event) => {
        if (!this.isStreaming) return;

        if (event.data.type === "audio") {
          const inputData = event.data.data;
          const pcmData = this.convertToPCM16(inputData);
          const base64Audio = this.arrayBufferToBase64(pcmData);

          // Send to Gemini
          if (this.client && this.client.connected) {
            this.client.sendAudioMessage(base64Audio);
          }
        }
      };

      // Connect the audio graph
      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      source.connect(this.audioWorklet);

      this.isStreaming = true;
      console.log("🎤 Audio streaming started");
      return true;
    } catch (error) {
      console.error("Failed to start audio streaming:", error);
      throw error;
    }
  }

  /**
   * Stop audio streaming
   */
  stop() {
    this.isStreaming = false;

    if (this.audioWorklet) {
      this.audioWorklet.disconnect();
      this.audioWorklet.port.close();
      this.audioWorklet = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    console.log("🛑 Audio streaming stopped");
  }

  /**
   * Convert Float32Array to PCM16 Int16Array
   */
  convertToPCM16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = sample * 0x7fff;
    }
    return int16Array.buffer;
  }

  /**
   * Convert ArrayBuffer to base64
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

/**
 * Base Video Capture - Shared functionality for video/screen capture
 */
class BaseVideoCapture {
  constructor(geminiClient) {
    this.client = geminiClient;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.mediaStream = null;
    this.isStreaming = false;
    this.captureInterval = null;
    this.fps = 1; // Default 1 frame per second
    this.quality = 0.8; // Default JPEG quality
  }

  /**
   * Initialize canvas and video elements
   */
  initializeElements(width, height) {
    // Create video element
    this.video = document.createElement("video");
    this.video.srcObject = this.mediaStream;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    // Create canvas for frame capture
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * Wait for video to be ready and start playing
   */
  async waitForVideoReady() {
    await new Promise((resolve) => {
      this.video.onloadedmetadata = resolve;
    });
    this.video.play();
  }

  /**
   * Start capturing and sending frames
   */
  startCapturing() {
    const captureFrame = () => {
      if (!this.isStreaming) return;

      // Draw current frame to canvas
      this.ctx.drawImage(
        this.video,
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );

      // Convert to JPEG and send
      this.canvas.toBlob(
        (blob) => {
          if (!blob) return;

          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result.split(",")[1];
            if (this.client && this.client.connected) {
              this.client.sendImageMessage(base64, "image/jpeg");
            }
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        this.quality
      );
    };

    // Start interval
    this.captureInterval = setInterval(captureFrame, 1000 / this.fps);
  }

  /**
   * Stop capturing
   */
  stop() {
    this.isStreaming = false;

    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }

    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Take a single snapshot
   */
  takeSnapshot() {
    if (!this.video || !this.canvas) {
      throw new Error("Video not initialized");
    }

    this.ctx.drawImage(
      this.video,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
    return this.canvas.toDataURL("image/jpeg", this.quality);
  }

  /**
   * Get the video element for preview
   */
  getVideoElement() {
    return this.video;
  }
}

/**
 * Video Streamer - Captures and streams camera video
 */
class VideoStreamer extends BaseVideoCapture {
  /**
   * Start video streaming from camera
   * @param {Object} options - { fps: number, width: number, height: number, facingMode: string, quality: number, deviceId: string }
   */
  async start(options = {}) {
    try {
      const {
        fps = 1,
        width = 640,
        height = 480,
        facingMode = "user", // 'user' for front camera, 'environment' for back
        quality = 0.8,
        deviceId = null,
      } = options;

      this.fps = fps;
      this.quality = quality;

      // Build video constraints
      const videoConstraints = {
        width: { ideal: width },
        height: { ideal: height },
      };

      // Add device ID if specified, otherwise use facingMode
      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      } else {
        videoConstraints.facingMode = facingMode;
      }

      // Get camera access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
      });

      // Initialize video and canvas elements
      this.initializeElements(width, height);

      // Wait for video to be ready
      await this.waitForVideoReady();

      // Start capturing frames
      this.isStreaming = true;
      this.startCapturing();

      console.log("📹 Camera streaming started at", fps, "fps");
      return this.video; // Return video element for preview
    } catch (error) {
      console.error("Failed to start camera streaming:", error);
      throw error;
    }
  }

  stop() {
    super.stop();
    console.log("🛑 Camera streaming stopped");
  }
}

/**
 * Screen Capture - Captures and streams screen/window
 */
class ScreenCapture extends BaseVideoCapture {
  /**
   * Start screen capture
   * @param {Object} options - { fps: number, width: number, height: number, quality: number }
   */
  async start(options = {}) {
    try {
      const {
        fps = 1,
        width = 1280,
        height = 720,
        quality = 0.7
      } = options;

      this.fps = fps;
      this.quality = quality;

      // Get screen capture permission
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      // Initialize video and canvas elements
      this.initializeElements(width, height);

      // Wait for video to be ready
      await this.waitForVideoReady();

      // Start capturing frames
      this.isStreaming = true;
      this.startCapturing();

      // Handle stream end (user stops sharing)
      this.mediaStream.getVideoTracks()[0].onended = () => {
        console.log("User stopped screen sharing");
        this.stop();
      };

      console.log("🖥️ Screen capture started at", fps, "fps");
      return this.video; // Return video element for preview
    } catch (error) {
      console.error("Failed to start screen capture:", error);
      throw error;
    }
  }

  stop() {
    super.stop();
    console.log("🛑 Screen capture stopped");
  }
}

/**
 * Audio Player - Plays audio responses from Gemini
 */
class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.workletNode = null;
    this.gainNode = null;
    this.isInitialized = false;
    this.volume = 1.0;
    this.sampleRate = 24000; // Gemini outputs at 24kHz
    this.isIdle = true;
    this.idleWaiters = [];

    // Jitter buffer: accumulate audio chunks before sending to worklet.
    // Trades latency for smoothness — eliminates stuttering from network jitter.
    // Phase 1: buffer until threshold → flush (builds playback runway)
    // Phase 2: pass-through (worklet's internal queue absorbs jitter)
    this.jitterBufferMs = 0; // 0 = disabled (pass-through)
    this._jitterQueue = []; // pending Float32Array chunks (phase 1 only)
    this._jitterSamples = 0; // total samples queued
    this._jitterFlushTimer = null;
    this._jitterPhase = 0; // 0 = not started, 1 = buffering, 2 = streaming

    // Lightweight observability for playback jitter/starvation.
    // Only measures mid-speech starvation (worklet runs dry while audio is expected).
    // Does NOT count the natural gap after speech ends (waitForIdle + inject).
    this._inSpeech = false; // true from first play() to onTurnComplete()
    this.obs = {
      lastDrainIdleAtMs: null,
      drainGapCount: 0,
      drainGapTotalMs: 0,
      drainGapMaxMs: 0,
      drainGapOver200Ms: 0,
    };
  }

  /**
   * Initialize the audio player
   */
  async init() {
    if (this.isInitialized) return;

    try {
      // Create audio context at 24kHz to match Gemini
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)({
        sampleRate: this.sampleRate,
      });

      // Load the audio worklet from external file
      await this.audioContext.audioWorklet.addModule(
        "audio-processors/playback.worklet.js"
      );

      // Create worklet node
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "pcm-processor"
      );

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.volume;

      // Connect nodes
      this.workletNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      // Track playback activity so we can wait for audio to fully drain.
      this.workletNode.port.onmessage = (event) => {
        const msg = event?.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "active") {
          // If we previously went idle mid-speech, measure the starvation gap.
          if (this.obs.lastDrainIdleAtMs != null) {
            const nowMs = performance.now();
            const gapMs = nowMs - this.obs.lastDrainIdleAtMs;
            this.obs.lastDrainIdleAtMs = null;

            this.obs.drainGapCount += 1;
            this.obs.drainGapTotalMs += gapMs;
            this.obs.drainGapMaxMs = Math.max(this.obs.drainGapMaxMs, gapMs);
            if (gapMs >= 200) this.obs.drainGapOver200Ms += 1;
          }
          this.isIdle = false;
          return;
        }
        if (msg.type === "idle") {
          this.isIdle = true;
          // Only measure drain gap if we're mid-speech (_inSpeech=true).
          // After onTurnComplete(), _inSpeech=false — the drain is the natural
          // end of speech, not a stutter. Don't pollute metrics with
          // waitForIdle() + inject round-trip time.
          if (msg.reason === "drain" && this._inSpeech) {
            this.obs.lastDrainIdleAtMs = performance.now();
          } else {
            this.obs.lastDrainIdleAtMs = null;
          }
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) {
            resolve();
          }
        }
      };

      this.isInitialized = true;
      console.log("🔊 Audio player initialized");
    } catch (error) {
      console.error("Failed to initialize audio player:", error);
      throw error;
    }
  }

  /**
   * Set jitter buffer size in milliseconds. 0 = disabled (pass-through).
   * Typical values: 200-500ms for mobile over tunnels.
   */
  setJitterBufferMs(ms) {
    this.jitterBufferMs = Math.max(0, Math.round(ms));
  }

  /**
   * Play audio chunk from base64 PCM
   */
  async play(base64Audio) {
    if (!this.isInitialized) {
      await this.init();
    }

    try {
      // Resume audio context if suspended
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Convert base64 to Float32Array
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert PCM16 LE to Float32
      const inputArray = new Int16Array(bytes.buffer);
      const float32Data = new Float32Array(inputArray.length);
      for (let i = 0; i < inputArray.length; i++) {
        float32Data[i] = inputArray[i] / 32768;
      }

      this._inSpeech = true;

      // Jitter buffer: phase 1 = accumulate initial buffer, phase 2 = pass-through.
      if (this.jitterBufferMs > 0) {
        // Phase 2: initial buffer already built, pass-through directly.
        if (this._jitterPhase === 2) {
          this.isIdle = false;
          this.workletNode.port.postMessage(float32Data);
          return;
        }

        // Phase 1: accumulate until threshold.
        this._jitterQueue.push(float32Data);
        this._jitterSamples += float32Data.length;
        const thresholdSamples = (this.jitterBufferMs / 1000) * this.sampleRate;

        if (this._jitterPhase === 0) {
          // First chunk: start buffering with a safety timeout for short utterances.
          this._jitterPhase = 1;
          this._jitterFlushTimer = setTimeout(() => {
            console.log(`⏱️ Jitter: timeout flush → streaming`);
            this._flushJitterBuffer();
            this._jitterPhase = 2;
          }, this.jitterBufferMs);
          console.log(`⏳ Jitter: buffering (target ${this.jitterBufferMs}ms)`);
        }

        if (this._jitterSamples >= thresholdSamples) {
          console.log(`⏳ Jitter: threshold reached → streaming`);
          this._flushJitterBuffer();
          this._jitterPhase = 2; // switch to pass-through
        }
        return;
      }

      // No jitter buffer: send directly to worklet
      this.isIdle = false;
      this.workletNode.port.postMessage(float32Data);
    } catch (error) {
      console.error("Error playing audio chunk:", error);
      throw error;
    }
  }

  /** Flush all queued jitter buffer chunks to the worklet. */
  _flushJitterBuffer() {
    if (this._jitterFlushTimer) {
      clearTimeout(this._jitterFlushTimer);
      this._jitterFlushTimer = null;
    }
    if (this._jitterQueue.length === 0) return;

    const chunks = this._jitterQueue.length;
    const ms = Math.round((this._jitterSamples / this.sampleRate) * 1000);
    console.log(`🔊 Jitter: flush ${chunks} chunks (${ms}ms audio)`);

    this.isIdle = false;
    for (const chunk of this._jitterQueue) {
      this.workletNode.port.postMessage(chunk);
    }
    this._jitterQueue = [];
    this._jitterSamples = 0;
  }

  /**
   * Wait until playback queue fully drains (no more audio output).
   */
  async waitForIdle() {
    if (!this.isInitialized) {
      await this.init();
    }
    if (this.isIdle) return;
    await new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Interrupt current playback
   */
  interrupt() {
    // Clear jitter buffer so queued audio doesn't play after interrupt.
    // Keep phase 2 (pass-through) — don't re-buffer after interrupt,
    // only re-buffer on new turn start (onTurnComplete resets to 0).
    this._jitterQueue = [];
    this._jitterSamples = 0;
    this._inSpeech = false;
    if (this._jitterFlushTimer) {
      clearTimeout(this._jitterFlushTimer);
      this._jitterFlushTimer = null;
    }
    if (this._jitterPhase === 1) {
      // Was still buffering when interrupted — skip to pass-through.
      this._jitterPhase = 2;
    }
    // If already phase 2 or 0, leave as-is.
    if (this.workletNode) {
      this.workletNode.port.postMessage("interrupt");
    }
  }

  /**
   * Signal that a turn completed — flush any remaining jitter buffer and reset.
   * Next turn will re-enter phase 1 (buffer) to rebuild the runway.
   */
  onTurnComplete() {
    this._flushJitterBuffer();
    this._jitterPhase = 0;
    this._inSpeech = false; // next idle is natural end-of-speech, don't measure
  }

  /**
   * Get current audio observability counters.
   */
  getObsSnapshot() {
    const avgGapMs =
      this.obs.drainGapCount > 0
        ? this.obs.drainGapTotalMs / this.obs.drainGapCount
        : 0;
    return {
      drainGapCount: this.obs.drainGapCount,
      drainGapAvgMs: avgGapMs,
      drainGapMaxMs: this.obs.drainGapMaxMs,
      drainGapOver200Ms: this.obs.drainGapOver200Ms,
    };
  }

  /**
   * Reset observability counters (useful between experiments).
   */
  resetObs() {
    this.obs.lastDrainIdleAtMs = null;
    this.obs.drainGapCount = 0;
    this.obs.drainGapTotalMs = 0;
    this.obs.drainGapMaxMs = 0;
    this.obs.drainGapOver200Ms = 0;
    this._inSpeech = false;
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.isInitialized = false;
  }
}