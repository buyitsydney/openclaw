import { describe, expect, it } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  buildOAuthSuccessNotificationText,
  buildOAuthSuccessPageHtml,
  requireUserToken,
  resolveOAuthRedirectUri,
  type FeishuUserToken,
} from "./oauth.js";

const fakeAccount = {
  accountId: "test-acct",
  knownBots: {},
  appId: "cli_test",
  appSecret: "secret",
  encryptKey: undefined,
  verificationToken: undefined,
} as unknown as ResolvedFeishuAccount;

const fakeToken: FeishuUserToken = {
  open_id: "ou_test123",
  name: "TestUser",
  access_token: "at_fake",
  refresh_token: "rt_fake",
  access_token_expires_at: Date.now() + 3600000,
  refresh_token_expires_at: Date.now() + 86400000,
  scopes: ["test"],
  created_at: Date.now(),
  updated_at: Date.now(),
};

describe("requireUserToken", () => {
  it("returns ok=true with a valid token", async () => {
    const result = await requireUserToken({
      account: fakeAccount,
      redirectUri: "https://test.example.com/feishu/oauth/callback",
      tokenPromise: Promise.resolve(fakeToken),
      toolLabel: "测试工具",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.open_id).toBe("ou_test123");
    }
  });

  it("returns ok=false with auth_url when token is null", async () => {
    const result = await requireUserToken({
      account: fakeAccount,
      redirectUri: "https://test.example.com/feishu/oauth/callback",
      tokenPromise: Promise.resolve(null),
      toolLabel: "群聊历史",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.authResponse.details as Record<string, unknown>;
      expect(details.error).toBe("user_auth_required");
      expect(typeof details.auth_url).toBe("string");
      expect((details.auth_url as string).startsWith("https://accounts.feishu.cn")).toBe(true);
      expect(details.auth_url as string).toContain("test.example.com");
      expect(details.message as string).toContain("群聊历史");

      const content = result.authResponse.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0].type).toBe("text");
      const parsed = JSON.parse(content[0].text);
      expect(parsed.auth_url).toBe(details.auth_url);
    }
  });

  it("includes correct scopes in the auth_url", async () => {
    const result = await requireUserToken({
      account: fakeAccount,
      redirectUri: "https://test.example.com/callback",
      tokenPromise: Promise.resolve(null),
      toolLabel: "飞书妙记",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const authUrl = (result.authResponse.details as Record<string, string>).auth_url;
      expect(authUrl).toContain("scope=");
      expect(authUrl).toContain("im%3Amessage%3Areadonly");
      expect(authUrl).toContain("minutes%3Aminutes");
    }
  });
});

describe("resolveOAuthRedirectUri", () => {
  it("reads new unified location: channels.feishu.oauthRedirectUri", () => {
    const uri = resolveOAuthRedirectUri({
      channels: {
        feishu: { oauthRedirectUri: "https://new.example.com/feishu/oauth/callback" },
      },
    });
    expect(uri).toBe("https://new.example.com/feishu/oauth/callback");
  });

  it("falls back to legacy: channels.feishu.minutes.oauthRedirectUri", () => {
    const uri = resolveOAuthRedirectUri({
      channels: {
        feishu: {
          minutes: { oauthRedirectUri: "https://legacy.example.com/feishu/oauth/callback" },
        },
      },
    });
    expect(uri).toBe("https://legacy.example.com/feishu/oauth/callback");
  });

  it("uses default when no config is set", () => {
    const uri = resolveOAuthRedirectUri({ channels: { feishu: {} } });
    expect(uri).toBe("https://auth.carher.net/feishu/oauth/callback");
  });

  it("new location takes priority over legacy", () => {
    const uri = resolveOAuthRedirectUri({
      channels: {
        feishu: {
          oauthRedirectUri: "https://new.example.com/callback",
          minutes: { oauthRedirectUri: "https://legacy.example.com/callback" },
        },
      },
    });
    expect(uri).toBe("https://new.example.com/callback");
  });

  it("handles missing channels config gracefully", () => {
    const uri = resolveOAuthRedirectUri({});
    expect(uri).toBe("https://auth.carher.net/feishu/oauth/callback");
  });
});

describe("OAuth success copy", () => {
  it("uses generic page copy instead of tool-specific wording", () => {
    const html = buildOAuthSuccessPageHtml("卜弋天");
    expect(html).toContain("飞书授权已完成");
    expect(html).toContain("授权范围内的飞书内容");
    expect(html).not.toContain("妙记/会议纪要");
  });

  it("uses generic chat copy instead of minutes-only wording", () => {
    const text = buildOAuthSuccessNotificationText("卜弋天");
    expect(text).toContain("飞书授权已完成");
    expect(text).toContain("授权范围内的飞书内容");
    expect(text).toContain("群聊历史");
    expect(text).toContain("会议纪要");
    expect(text).not.toContain("我现在可以读取你的飞书妙记和会议纪要了");
  });
});
