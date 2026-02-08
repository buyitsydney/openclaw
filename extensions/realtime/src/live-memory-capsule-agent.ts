import crypto from "node:crypto";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { buildBackendModePrompt } from "./prompt.js";

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

export async function generateLiveMemoryCapsule(params: {
  coreDeps: CoreAgentDeps;
  cfg: CoreConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  userProfileMd: string;
  memoryMd: string;
}): Promise<string> {
  const { coreDeps, cfg, agentId, agentDir, workspaceDir, userProfileMd, memoryMd } = params;

  // Always use a fresh session — prevents historical contamination.
  // The capsule agent has tools (exec, read) and can escape workspace boundaries;
  // reusing sessions lets it "remember" leaked data from prior runs.
  const sessionId = crypto.randomUUID();
  const sessionKey = `realtime_capsule:${agentId}`;
  const sessionEntry: SessionEntry = { sessionId, updatedAt: Date.now() };

  const storePath = coreDeps.resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore = coreDeps.loadSessionStore(storePath);
  sessionStore[sessionKey] = sessionEntry;
  await coreDeps.saveSessionStore(storePath, sessionStore);

  const sessionFile = coreDeps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Shared environment (v3)
  const extraSystemPrompt = buildBackendModePrompt("");

  // Scenario: Capsule generation (v3)
  const prompt = `你将看到两份材料：USER.md（用户画像）与 MEMORY.md（长期记忆）。

前台 Live 的事实背景：
- Live 使用 Gemini Live 实时语音模型：gemini-live-2.5-flash-native-audio
- Live 负责低延时语音对话；它的上下文与工具能力弱于你
- 你生成的"胶囊"会被放入 Live 的 system prompt（开局 setup），并长期影响 Live 的对话

请把其中"Live 必须长期掌握"的信息压缩成一段高密度胶囊，供 Live 放入它的 system prompt。
要求：
- 胶囊必须让 Live 能够直接回答：用户是谁/应该如何称呼用户。
- 只保留能显著提升 Live 对话质量的"用户层事实/偏好/安全约束/称呼/时区/沟通偏好"等。
- 不要写解释，不要写过程。
- 不要编造：只写你有把握且材料里确实存在的内容。
- ⚠️ 严禁使用任何工具（exec、read、memory_search 等）！材料内容已完整提供在下方，不需要也不允许额外查找。
- ⚠️ 如果两份材料都是"（空）"，直接输出"## Live 必知记忆（胶囊）\\n\\n（暂无用户信息）"，不要尝试搜索或读取文件。

输出格式：
以"## Live 必知记忆（胶囊）"开头，后面只用项目符号列表。

---

[USER.md]
${userProfileMd || "（空）"}

---

[MEMORY.md]
${memoryMd || "（空）"}`;

  const agentDefaults = (cfg as Record<string, unknown>).agents as
    | { defaults?: { model?: { primary?: string } } }
    | undefined;
  const modelRef =
    agentDefaults?.defaults?.model?.primary || `${coreDeps.DEFAULT_PROVIDER}/${coreDeps.DEFAULT_MODEL}`;

  const parts = modelRef.split("/");
  const provider = parts[0] || coreDeps.DEFAULT_PROVIDER;
  const model = parts.slice(1).join("/") || coreDeps.DEFAULT_MODEL;

  const thinkLevel = coreDeps.resolveThinkingDefault({ cfg, provider, model });
  const timeoutMs = coreDeps.resolveAgentTimeoutMs({ cfg });

  const result = await coreDeps.runEmbeddedPiAgent({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    messageProvider: "realtime",
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt,
    provider,
    model,
    thinkLevel,
    verboseLevel: "off",
    timeoutMs,
    runId: `realtime:capsule:${Date.now()}`,
    lane: "realtime",
    extraSystemPrompt,
    agentDir,
  });

  const texts = (result.payloads ?? [])
    .filter((p) => p.text && !p.isError)
    .map((p) => p.text?.trim())
    .filter(Boolean);

  return (texts.join("\n") || "").trim();
}
