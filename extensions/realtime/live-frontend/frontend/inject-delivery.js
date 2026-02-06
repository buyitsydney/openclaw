/**
 * Inject delivery helper (testable).
 *
 * This file is loaded by the browser via a plain <script> tag (non-module),
 * so we attach the API to globalThis.
 *
 * Design goals:
 * - Deterministic: deliver at most one queued inject per TURN_COMPLETE.
 * - Safe: wait for local playback to drain before injecting.
 * - Trigger: after injecting backend material as role=model, send a control
 *   line as role=user to trigger the model to immediately speak.
 */
(function attachInjectDelivery(global) {
  /**
   * Deliver the next pending inject (at most one) if allowed by gating.
   *
   * @param {object} args
   * @param {object|null} args.client - GeminiLiveAPI-like client with sendTextMessage().
   * @param {object|null} args.audioPlayer - Optional audio player with waitForIdle().
   * @param {object} args.state - State object with injectChain, pendingInjects, gemini.turnComplete.
   * @param {string} args.controlLine - Control line to trigger Gemini to speak.
   * @param {function} [args.onError] - Optional error handler.
   */
  function deliverNextInject({ client, audioPlayer, state, controlLine, onError }) {
    if (!client) return;
    if (!state?.gemini?.turnComplete) return;
    if (!state?.pendingInjects?.length) return;

    // Deliver at most one inject per TURN_COMPLETE.
    const reply = state.pendingInjects.shift();

    const chain = state.injectChain || Promise.resolve();
    state.injectChain = chain
      .then(async () => {
        if (!client) return;

        if (audioPlayer && typeof audioPlayer.waitForIdle === "function") {
          await audioPlayer.waitForIdle();
        }

        // Mark as in-progress until the next TURN_COMPLETE arrives.
        if (state?.gemini) state.gemini.turnComplete = false;

        // 1) Inject backend material as context (role=model).
        client.sendTextMessage(reply, { role: "model" });
        // 2) Send control line as role=user to trigger Gemini to speak immediately.
        client.sendTextMessage(controlLine, { role: "user" });
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
      });
  }

  global.OpenClawInjectDelivery = {
    deliverNextInject,
  };
})(globalThis);

