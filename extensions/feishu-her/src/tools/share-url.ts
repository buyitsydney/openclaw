import type { ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi } from "./chat-api.js";

type DriveMeta = {
  url?: string;
  doc_token?: string;
  doc_type?: string;
  title?: string;
};

type DriveMetaResponse = {
  metas?: DriveMeta[];
};

export type DriveDocType =
  | "wiki"
  | "doc"
  | "docx"
  | "sheet"
  | "bitable"
  | "mindnote"
  | "file"
  | "slides";

export type ShareUrlResolveResult =
  | {
      ok: true;
      share_url: string;
      meta: DriveMeta;
    }
  | {
      ok: false;
      error: string;
      code?: number;
      msg?: string;
      http_status?: number;
    };

/**
 * Resolve canonical Feishu share URL via Drive Meta Batch Query.
 * Official API: /open-apis/drive/v1/metas/batch_query (with_url=true).
 */
export async function resolveDriveShareUrl(
  account: ResolvedFeishuAccount,
  docToken: string,
  docType: DriveDocType,
): Promise<ShareUrlResolveResult> {
  const trimmedToken = docToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: "doc_token is required" };
  }

  const result = await callChatApi<DriveMetaResponse>({
    account,
    method: "POST",
    endpoint: "/drive/v1/metas/batch_query",
    body: {
      request_docs: [{ doc_token: trimmedToken, doc_type: docType }],
      with_url: true,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      error: "drive_meta_batch_query_failed",
      code: result.code,
      msg: result.msg,
      http_status: result.http_status,
    };
  }

  const metas = result.data?.metas;
  if (!Array.isArray(metas) || metas.length === 0) {
    return { ok: false, error: "drive_meta_batch_query_empty_result" };
  }

  const first = metas[0];
  const url = typeof first?.url === "string" ? first.url.trim() : "";
  if (!url) {
    return { ok: false, error: "drive_meta_batch_query_missing_url" };
  }

  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: false, error: "drive_meta_batch_query_invalid_url" };
  }

  if (hostname === "open.feishu.cn") {
    return { ok: false, error: "drive_meta_batch_query_invalid_open_platform_host" };
  }

  return {
    ok: true,
    share_url: url,
    meta: first,
  };
}
