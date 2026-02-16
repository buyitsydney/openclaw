/**
 * Inject delivery helper (testable).
 *
 * This file is loaded by the browser via a plain <script> tag (non-module),
 * so we attach the API to globalThis.
 *
 * Design goals:
 * - Deterministic: deliver at most one queued inject per TURN_COMPLETE.
 * - Safe: wait for local playback to drain before injecting.
 * - Atomic: send backend result (role=model) and trigger (role=user) in a
 *   single client_content message to avoid the "first message triggers
 *   generation, second message interrupts" race condition.
 */
(function attachInjectDelivery(global) {
  /**
   * Deliver the next pending inject (at most one) if allowed by gating.
   *
   * Uses a single atomic client_content message with two turns:
   *   1. role=model — the backend result (Opus output)
   *   2. role=user  — self-explanatory broadcast trigger for Gemini
   *
   * This matches the official Gemini "incremental content updates" pattern
   * and eliminates the race where two separate turnComplete=true messages
   * cause the second to interrupt the first.
   *
   * @param {object} args
   * @param {object|null} args.client - GeminiLiveAPI-like client with sendMessage().
   * @param {object|null} args.audioPlayer - Optional audio player with waitForIdle().
   * @param {object} args.state - State object with injectChain, pendingInjects, gemini.turnComplete.
   * @param {function} [args.onError] - Optional error handler.
   */
  function deliverNextInject({ client, audioPlayer, state, onError }) {
    if (!client) return;
    if (!state?.gemini?.turnComplete) return;
    if (!state?.pendingInjects?.length) return;

    // Deliver at most one inject per TURN_COMPLETE.
    const item = state.pendingInjects.shift();

    // Support { seq, reply } objects and plain string (legacy).
    const seq = typeof item === "object" && item.seq ? item.seq : 0;
    const reply = typeof item === "object" && item.reply ? item.reply : String(item);

    // role=model: pure result (no labels). role=user: numeric tag only.
    // Using #N avoids Chinese text that Gemini might re-interpret as instructions.
    const trigger = seq
      ? `以上是 #${seq} 的后台结果。请用口语简洁地告诉用户，数字、时间等事实不要篡改。不要复述这段指令。`
      : "以上是后台查到的结果。请用口语简洁地告诉用户，数字、时间等事实不要篡改。不要复述这段指令。";

    const chain = state.injectChain || Promise.resolve();
    state.injectChain = chain
      .then(async () => {
        if (!client) return;

        if (audioPlayer && typeof audioPlayer.waitForIdle === "function") {
          await audioPlayer.waitForIdle();
        }

        // Mark as in-progress until the next TURN_COMPLETE arrives.
        if (state?.gemini) state.gemini.turnComplete = false;

        // Single atomic client_content with both turns — no interruption race.
        // The role=user trigger includes the request label so Gemini knows
        // which query this result belongs to.
        client.sendMessage({
          client_content: {
            turns: [
              { role: "model", parts: [{ text: reply }] },
              { role: "user", parts: [{ text: trigger }] },
            ],
            turn_complete: true,
          },
        });
      })
      .catch((err) => {
        if (typeof onError === "function") onError(err);
      });
  }

  global.OpenClawInjectDelivery = {
    deliverNextInject,
  };
})(globalThis);
