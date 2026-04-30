/**
 * Helper: build sendDirectToUser callback for OAuth card delivery.
 * Sends OAuth links directly to the user via Feishu card API,
 * bypassing model text generation to prevent URL corruption.
 */

import type { ResolvedFeishuAccount } from "../accounts.js";
import { sendFeishuRichText } from "../outbound.js";

let _currentChatId: string | undefined;
let _currentAccount: ResolvedFeishuAccount | undefined;

export function setOAuthDirectContext(account: ResolvedFeishuAccount, chatId: string): void {
  _currentAccount = account;
  _currentChatId = chatId;
}

export function clearOAuthDirectContext(): void {
  _currentAccount = undefined;
  _currentChatId = undefined;
}

export function buildSendDirectToUser(
  account: ResolvedFeishuAccount,
  chatId: string | undefined,
): ((text: string) => Promise<void>) | undefined {
  const effectiveChatId = chatId || _currentChatId;
  const effectiveAccount = account || _currentAccount;
  if (!effectiveChatId || !effectiveAccount) return undefined;
  return async (text: string) => {
    await sendFeishuRichText({ account: effectiveAccount, chatId: effectiveChatId, text });
  };
}

export function getOAuthDirectSender(
  account: ResolvedFeishuAccount,
): ((text: string) => Promise<void>) | undefined {
  const chatId = _currentChatId;
  if (!chatId) return undefined;
  return async (text: string) => {
    await sendFeishuRichText({ account, chatId, text });
  };
}
