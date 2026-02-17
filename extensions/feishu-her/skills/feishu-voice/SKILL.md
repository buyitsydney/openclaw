---
name: feishu-voice
description: |
  Feishu voice message handling. Activate when user sends voice/audio messages or asks about voice replies.
---

# Feishu Voice Guidelines

## Inbound Voice (User → AI)

When a user sends a voice message, the system automatically transcribes it (STT) and provides the text. Treat it as a normal text message — no special handling needed.

## Outbound Voice (AI → User)

**CRITICAL: Do NOT manually call the TTS tool.** The system is configured with `tts.auto = "inbound"`, which means:

- When the user sends a voice message, the system **automatically** converts your text reply into a voice message.
- You only need to reply with normal text. The system handles voice synthesis and delivery.
- Manually calling `tts()` will cause duplicate voice messages and delivery errors.

## Summary

| Scenario                       | Your action                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| User sends voice               | Reply with text only. System auto-generates voice.                                              |
| User sends text                | Reply with text only. No voice generated.                                                       |
| User explicitly asks for voice | Reply with text only. If `tts.auto` is `inbound`, voice is only auto-generated for voice input. |
