export type TranscriptRole = "user" | "live";

export type Turn = {
  turnId: string;
  createdAt: number;
  userText: string;
  liveText: string;
};

/**
 * TurnAssembler
 *
 * Minimal deterministic turn closure:
 * - Only considers "final" transcripts (frontend already only sends finished=true).
 * - A turn closes when we have one user transcript and the next live transcript.
 *
 * This is intentionally simple and isolated so we can iterate without
 * affecting any other subsystem.
 */
export class TurnAssembler {
  private seq = 0;
  private userQueue: Array<{ text: string; at: number }> = [];

  constructor(private readonly prefix: string) {}

  push(params: { role: TranscriptRole; text: string; at?: number }): Turn[] {
    const at = params.at ?? Date.now();
    const text = params.text.trim();
    if (!text) {
      return [];
    }

    if (params.role === "user") {
      this.userQueue.push({ text, at });
      return [];
    }

    // role === "live"
    const user = this.userQueue.shift();
    if (!user) {
      // Live-only transcript with no preceding user turn. We ignore it.
      return [];
    }

    this.seq += 1;
    const turnId = `${this.prefix}:turn:${this.seq}`;
    return [
      {
        turnId,
        createdAt: user.at,
        userText: user.text,
        liveText: text,
      },
    ];
  }

  /**
   * Flush at most one pending user entry into a turn when we know the model
   * finished a turn (TURN_COMPLETE), but we don't have a usable live transcript.
   *
   * This keeps the "turn triggers supervision" property deterministic even
   * when output transcription is empty for audio-only replies.
   */
  flushTurnComplete(params?: { at?: number }): Turn[] {
    const user = this.userQueue.shift();
    if (!user) {
      return [];
    }

    this.seq += 1;
    const turnId = `${this.prefix}:turn:${this.seq}`;
    return [
      {
        turnId,
        createdAt: params?.at ?? user.at,
        userText: user.text,
        liveText: "",
      },
    ];
  }
}

