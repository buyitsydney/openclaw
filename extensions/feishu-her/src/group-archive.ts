import crypto from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, parse } from "node:path";
import { extractPdfContent } from "../../../src/media/pdf-extract.ts";

export type ArchiveLogSink = {
  info?: (message: string) => void;
  error?: (message: string) => void;
};

export type GroupArchiveEntry = {
  ts: number;
  sender: string;
  senderId: string;
  text: string;
  msgId: string;
};

const OFFICE_EXTS = new Set([".pptx", ".docx", ".xlsx", ".odt", ".odp", ".ods", ".rtf"]);
const MAX_OFFICE_CHARS = 100_000;
const MAX_PDF_PAGES = 5;
const MAX_PDF_PIXELS = 3_000_000;

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".openclaw");
}

export function resolveGroupArchiveDir(): string {
  return join(resolveStateDir(), "feishu-groups");
}

function resolveInboundMediaDir(): string {
  return join(resolveStateDir(), "media", "inbound");
}

export function loadArchiveEntries(chatId: string): Map<string, GroupArchiveEntry> {
  const archivePath = join(resolveGroupArchiveDir(), chatId, "messages.jsonl");
  const map = new Map<string, GroupArchiveEntry>();
  if (!existsSync(archivePath)) return map;
  try {
    const content = readFileSync(archivePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as GroupArchiveEntry;
        if (entry.msgId) map.set(entry.msgId, entry);
      } catch {
        // Ignore malformed archive lines.
      }
    }
  } catch {
    // Ignore unreadable archive files.
  }
  return map;
}

export function archiveGroupMessage(params: {
  chatId: string;
  chatName: string | null;
  senderId: string;
  senderName: string;
  text: string;
  msgId: string;
  ts?: number;
}): void {
  const archiveDir = resolveGroupArchiveDir();
  const chatDir = join(archiveDir, params.chatId);

  if (!existsSync(chatDir)) {
    mkdirSync(chatDir, { recursive: true });
  }

  const record: GroupArchiveEntry = {
    ts: params.ts ?? Math.floor(Date.now() / 1000),
    sender: params.senderName || params.senderId,
    senderId: params.senderId,
    text: params.text,
    msgId: params.msgId,
  };
  appendFileSync(join(chatDir, "messages.jsonl"), JSON.stringify(record) + "\n");

  const indexPath = join(archiveDir, "index.json");
  let index: Record<string, { name: string; lastMessage: string }> = {};
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {
    // Ignore corrupted index and rebuild it.
  }

  index[params.chatId] = {
    name: params.chatName || index[params.chatId]?.name || params.chatId,
    lastMessage: new Date((params.ts ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

function extensionForContentType(contentType?: string): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/vnd.ms-powerpoint":
      return ".ppt";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/msword":
      return ".doc";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.ms-excel":
      return ".xls";
    case "text/plain":
      return ".txt";
    case "text/csv":
      return ".csv";
    case "application/zip":
      return ".zip";
    default:
      return "";
  }
}

function resolveArchiveFileName(params: {
  fileName?: string;
  contentType?: string;
  defaultBaseName: string;
}): string {
  const trimmed = params.fileName?.trim();
  if (trimmed) return trimmed;
  return `${params.defaultBaseName}${extensionForContentType(params.contentType)}`;
}

export async function saveArchiveBuffer(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
}): Promise<{ path: string; fileName: string }> {
  const fileName = resolveArchiveFileName(params);
  const parsed = parse(fileName);
  const base = sanitizeFilename(parsed.name) || sanitizeFilename(params.defaultBaseName) || "file";
  const ext = parsed.ext || extensionForContentType(params.contentType);
  const finalName = `${base}---${crypto.randomUUID()}${ext}`;
  const dir = resolveInboundMediaDir();
  const path = join(dir, finalName);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, params.buffer, { mode: 0o644 });
  return { path, fileName };
}

/**
 * Walk the officeparser AST to produce rich text with slide separators and chart data.
 * Falls back to ast.toText() if the AST structure is unexpected.
 */
// oxlint-disable-next-line typescript/no-explicit-any
function formatOfficeAst(ast: any, maxChars: number): string {
  if (!ast) return "";
  const content = ast.content as unknown[];
  if (!Array.isArray(content) || content.length === 0) {
    return (ast.toText?.() ?? "").slice(0, maxChars).trim();
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  const chartDataByName = new Map<string, any>();
  const attachments = ast.attachments as unknown[];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const a = att as any;
      if (a.chartData && a.name) {
        chartDataByName.set(a.name, a.chartData);
      }
    }
  }

  const lines: string[] = [];
  let slideNum = 0;
  let charCount = 0;

  // oxlint-disable-next-line typescript/no-explicit-any
  function walkNode(node: any): void {
    if (charCount >= maxChars || !node) return;
    const type = node.type as string;

    if (type === "slide" || type === "section") {
      slideNum++;
      const sep = `\n--- Slide ${slideNum} ---\n`;
      lines.push(sep);
      charCount += sep.length;
    }

    if (type === "chart") {
      const attachmentName = node.metadata?.attachmentName as string | undefined;
      const chartData = attachmentName ? chartDataByName.get(attachmentName) : undefined;
      if (chartData) {
        const parts: string[] = [];
        parts.push(chartData.title ? `[Chart: ${chartData.title}]` : "[Chart]");
        const labels = chartData.labels as string[] | undefined;
        const dataSets = chartData.dataSets as unknown[] | undefined;
        if (Array.isArray(labels) && labels.length > 0) {
          parts.push(`  Categories: ${labels.join(", ")}`);
        }
        if (Array.isArray(dataSets)) {
          for (const dataSet of dataSets) {
            // oxlint-disable-next-line typescript/no-explicit-any
            const d = dataSet as any;
            const values = Array.isArray(d.values) ? d.values.join(", ") : String(d.values ?? "");
            const name = d.name ? `${d.name}: ` : "";
            parts.push(`  Data: ${name}${values}`);
          }
        }
        const chartText = parts.join("\n") + "\n";
        lines.push(chartText);
        charCount += chartText.length;
      }
    }

    if (type === "table" && Array.isArray(node.children)) {
      const rows = node.children.filter((row: { type: string }) => row.type === "row");
      for (const row of rows) {
        if (charCount >= maxChars) break;
        // oxlint-disable-next-line typescript/no-explicit-any
        const cells = (row.children ?? []).filter((cell: any) => cell.type === "cell");
        // oxlint-disable-next-line typescript/no-explicit-any
        const rowText = cells
          .map((cell: any) => (cell.text ?? "").replace(/[\t\n]/g, " "))
          .join("\t");
        lines.push(rowText);
        charCount += rowText.length + 1;
      }
      lines.push("");
      return;
    }

    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    if (hasChildren && type !== "table") {
      for (const child of node.children) {
        if (charCount >= maxChars) break;
        walkNode(child);
      }
    } else if (!hasChildren && node.text && type !== "table" && type !== "row" && type !== "cell") {
      const text = String(node.text).trim();
      if (text) {
        lines.push(text);
        charCount += text.length + 1;
      }
    }
  }

  for (const node of content) {
    if (charCount >= maxChars) break;
    walkNode(node);
  }

  return lines.join("\n").slice(0, maxChars).trim();
}

function buildArchivePathLine(fileName: string, savedPath: string): string {
  return `[file: ${fileName} saved at ${savedPath}]`;
}

export function buildArchiveFailureText(fileName: string, reason: string): string {
  return `[file: ${fileName} (${reason})]`;
}

export async function buildArchiveTextFromSavedFile(params: {
  fileName: string;
  savedPath: string;
  log?: ArchiveLogSink;
  includePathLine?: boolean;
}): Promise<string> {
  const ext = extname(params.fileName).toLowerCase();
  const pathLine = buildArchivePathLine(params.fileName, params.savedPath);
  const includePathLine = params.includePathLine ?? true;
  const appendPathLine = (text: string): string =>
    includePathLine ? `${text}\n${pathLine}` : text;
  if (ext === ".pdf") {
    try {
      const buffer = readFileSync(params.savedPath);
      const extracted = await extractPdfContent({
        buffer,
        maxPages: MAX_PDF_PAGES,
        maxPixels: MAX_PDF_PIXELS,
        minTextChars: 1,
      });
      const text = extracted.text.slice(0, MAX_OFFICE_CHARS).trim();
      if (!text) return includePathLine ? pathLine : "";
      return appendPathLine(`<file name="${params.fileName}">\n${text}\n</file>`);
    } catch (err) {
      params.log?.error?.(`pdf extraction failed (${params.fileName}): ${String(err)}`);
      return includePathLine ? pathLine : "";
    }
  }
  if (!OFFICE_EXTS.has(ext)) return includePathLine ? pathLine : "";

  try {
    const { parseOffice } = await import("officeparser");
    const ast = await parseOffice(params.savedPath, { extractAttachments: true });
    const text = formatOfficeAst(ast, MAX_OFFICE_CHARS);
    if (!text) return includePathLine ? pathLine : "";
    return appendPathLine(`<file name="${params.fileName}">\n${text}\n</file>`);
  } catch (err) {
    params.log?.error?.(`office extraction failed (${params.fileName}): ${String(err)}`);
    return includePathLine ? pathLine : "";
  }
}

export async function createArchiveTextForBuffer(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
  log?: ArchiveLogSink;
  includePathLine?: boolean;
}): Promise<string> {
  const saved = await saveArchiveBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
    defaultBaseName: params.defaultBaseName,
  });
  return buildArchiveTextFromSavedFile({
    fileName: saved.fileName,
    savedPath: saved.path,
    log: params.log,
    includePathLine: params.includePathLine,
  });
}

export async function archiveSentFeishuBinaryMessage(params: {
  chatId: string;
  messageId?: string;
  senderId: string;
  senderName?: string;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
  log?: ArchiveLogSink;
}): Promise<void> {
  if (!params.messageId || !params.chatId.startsWith("oc_")) return;
  const text = await createArchiveTextForBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
    defaultBaseName: params.defaultBaseName,
    log: params.log,
  });
  archiveGroupMessage({
    chatId: params.chatId,
    chatName: null,
    senderId: params.senderId,
    senderName: params.senderName ?? params.senderId,
    text,
    msgId: params.messageId,
  });
}

type ArchiveSupplementableMessage = {
  text: string;
  coverage: "full" | "partial" | "none";
};

export function applyArchiveTextToMessage<T extends ArchiveSupplementableMessage>(
  message: T,
  archiveText: string,
): void {
  if (message.coverage === "none") {
    message.text = archiveText;
    message.coverage = "partial";
    return;
  }
  message.text += `\n[local archive: ${archiveText}]`;
}
