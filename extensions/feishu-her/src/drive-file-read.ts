import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/feishu";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { createArchiveTextForBuffer } from "./group-archive.js";
import { callFeishuApiWithUserToken, getValidUserToken } from "./oauth.js";

const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn"];

type DriveMeta = {
  doc_token?: string;
  doc_type?: string;
  title?: string;
  url?: string;
};

type DriveMetaResponse = {
  metas?: DriveMeta[];
};

export type DriveFileLink = {
  token: string;
  url: string;
};

export type DriveFileContextResult =
  | {
      ok: true;
      token: string;
      title: string;
      contentType: string;
      content: string;
    }
  | {
      ok: false;
      token: string;
      title?: string;
      reason: string;
    };

async function getDriveFileMeta(params: {
  userToken: string;
  fileToken: string;
}): Promise<{ title: string | null }> {
  const response = await callFeishuApiWithUserToken<DriveMetaResponse>({
    method: "POST",
    endpoint: "/drive/v1/metas/batch_query",
    userToken: params.userToken,
    body: {
      request_docs: [{ doc_token: params.fileToken, doc_type: "file" }],
      with_url: true,
    },
  });
  if (response.code !== 0) {
    return { title: null };
  }
  const meta = Array.isArray(response.data?.metas) ? response.data.metas[0] : undefined;
  const title = typeof meta?.title === "string" ? meta.title.trim() : "";
  return { title: title || null };
}

function extractFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // RFC 6266: filename*=UTF-8''encoded or filename="quoted"
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^\s;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      /* fall through */
    }
  }
  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const plainMatch = header.match(/filename\s*=\s*([^\s;]+)/i);
  return plainMatch?.[1]?.trim() || null;
}

async function downloadDriveFile(params: {
  userToken: string;
  fileToken: string;
}): Promise<
  | { ok: true; buffer: Buffer; contentType: string; fileName: string | null }
  | { ok: false; reason: string }
> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `https://open.feishu.cn/open-apis/drive/v1/files/${params.fileToken}/download`,
    init: {
      headers: {
        Authorization: `Bearer ${params.userToken}`,
      },
    },
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: `feishu-drive-file-download:${params.fileToken}`,
  });
  try {
    if (!response.ok) {
      const body = (await response.text()).trim();
      return {
        ok: false,
        reason: `drive download failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return { ok: false, reason: "drive download returned empty body" };
    }
    return {
      ok: true,
      buffer,
      contentType: response.headers.get("content-type")?.trim() ?? "application/octet-stream",
      fileName: extractFilenameFromContentDisposition(response.headers.get("content-disposition")),
    };
  } finally {
    await release();
  }
}

async function extractDriveFileContent(params: {
  title: string;
  contentType: string;
  buffer: Buffer;
}): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const content = await createArchiveTextForBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.title,
    defaultBaseName: "feishu-drive-file",
    includePathLine: true,
  });
  if (!content) {
    return { ok: false, reason: `unsupported file type: ${params.title}` };
  }
  return { ok: true, content };
}

export function extractDriveFileLinks(text: string): DriveFileLink[] {
  if (!text.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const results: DriveFileLink[] = [];
  const rawUrls = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  for (const rawUrl of rawUrls) {
    const trimmed = rawUrl.replace(/[),.!?;，。！？；）】》]+$/gu, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (!parsed.hostname.endsWith(".feishu.cn")) {
      continue;
    }
    const match = parsed.pathname.match(/^\/file\/([A-Za-z0-9]+)/);
    const token = match?.[1]?.trim();
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    results.push({ token, url: trimmed });
  }
  return results;
}

export async function readDriveFileContextByToken(params: {
  account: ResolvedFeishuAccount;
  fileToken: string;
}): Promise<DriveFileContextResult> {
  const token = await getValidUserToken(params.account);
  if (!token) {
    return { ok: false, token: params.fileToken, reason: "missing Feishu user authorization" };
  }

  const meta = await getDriveFileMeta({
    userToken: token.access_token,
    fileToken: params.fileToken,
  });

  const download = await downloadDriveFile({
    userToken: token.access_token,
    fileToken: params.fileToken,
  });
  if (!download.ok) {
    return {
      ok: false,
      token: params.fileToken,
      title: meta.title ?? undefined,
      reason: download.reason,
    };
  }

  // Title priority: meta API > Content-Disposition header > fileToken fallback
  const title = meta.title ?? download.fileName ?? params.fileToken;

  const extracted = await extractDriveFileContent({
    title,
    contentType: download.contentType,
    buffer: download.buffer,
  });
  if (!extracted.ok) {
    return { ok: false, token: params.fileToken, title, reason: extracted.reason };
  }

  return {
    ok: true,
    token: params.fileToken,
    title,
    contentType: download.contentType,
    content: extracted.content,
  };
}

export async function buildDriveFileContextFromText(params: {
  account: ResolvedFeishuAccount;
  text: string;
  maxFiles?: number;
}): Promise<string> {
  const links = extractDriveFileLinks(params.text);
  if (links.length === 0) {
    return "";
  }

  const limit = Math.max(1, params.maxFiles ?? 3);
  const blocks: string[] = [];
  for (const link of links.slice(0, limit)) {
    const result = await readDriveFileContextByToken({
      account: params.account,
      fileToken: link.token,
    });
    if (result.ok) {
      blocks.push(result.content);
      continue;
    }
    const label = result.title ? `${result.title} (${result.token})` : result.token;
    blocks.push(`[drive file read failed: ${label}; ${result.reason}]`);
  }
  return blocks.join("\n");
}
