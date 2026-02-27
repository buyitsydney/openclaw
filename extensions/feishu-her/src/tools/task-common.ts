import type * as Lark from "@larksuiteoapi/node-sdk";

export function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function errorResult(err: unknown) {
  return json({ error: err instanceof Error ? err.message : String(err) });
}

function extractFeishuError(err: unknown): { code?: number; msg?: string; logId?: string } | null {
  if (!err) return null;
  if (Array.isArray(err)) {
    for (let i = err.length - 1; i >= 0; i -= 1) {
      const nested = extractFeishuError(err[i]);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof err !== "object") return null;
  const obj = err as Record<string, unknown>;
  const response = obj.response as { data?: unknown } | undefined;
  if (response?.data) return extractFeishuError(response.data);
  const code = typeof obj.code === "number" ? obj.code : undefined;
  const msg = typeof obj.msg === "string" ? obj.msg : undefined;
  const logId =
    typeof obj.log_id === "string"
      ? obj.log_id
      : typeof obj.logId === "string"
        ? obj.logId
        : undefined;
  if (code !== undefined || msg || logId) return { code, msg, logId };
  return null;
}

export async function runTaskApiCall<T>(
  context: string,
  fn: () => Promise<{ code?: number; msg?: string; log_id?: string; logId?: string } & T>,
): Promise<T> {
  try {
    const resp = await fn();
    if (resp.code === undefined || resp.code === 0) return resp;
    const logId = resp.log_id ?? resp.logId;
    const detail = logId ? `, log_id=${logId}` : "";
    throw new Error(
      `${context} failed: ${resp.msg ?? `code=${resp.code}`}, code=${resp.code}${detail}`,
    );
  } catch (err) {
    const info = extractFeishuError(err);
    if (info) {
      const detail = info.logId ? `, log_id=${info.logId}` : "";
      throw new Error(
        `${context} failed: ${info.msg ?? `code=${info.code}`}${info.code !== undefined ? `, code=${info.code}` : ""}${detail}`,
      );
    }
    throw err instanceof Error ? err : new Error(`${context} failed: ${String(err)}`);
  }
}

export type TaskClient = Lark.Client;
