/**
 * Media helpers for feishu-her.
 * These were previously available from openclaw/plugin-sdk/feishu but moved
 * out of the plugin SDK in v2026.4.x.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
	const trimmed = base64.trim();
	if (!trimmed) return undefined;
	const take = Math.min(256, trimmed.length);
	const sliceLen = take - (take % 4);
	if (sliceLen < 8) return undefined;
	try {
		const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
		if (head.length < 4) return undefined;
		if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
		if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
		if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
		if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "application/pdf";
		return undefined;
	} catch {
		return undefined;
	}
}

type PdfExtractedContent = { text: string; numPages: number };

/**
 * Extract text from a PDF buffer. Uses pdftotext (poppler-utils) if available,
 * falls back to basic text extraction from the raw PDF stream.
 */
export async function extractPdfContent(params: {
	buffer: Buffer;
	maxPages: number;
	maxPixels: number;
	minTextChars: number;
	pageNumbers?: number[];
	onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent> {
	// Try pdftotext (available in Docker via poppler-utils)
	try {
		const dir = mkdtempSync(join(tmpdir(), "pdf-extract-"));
		const inFile = join(dir, "input.pdf");
		const outFile = join(dir, "output.txt");
		writeFileSync(inFile, params.buffer);
		execSync(`pdftotext -l ${params.maxPages} "${inFile}" "${outFile}"`, {
			timeout: 30_000,
			stdio: "pipe",
		});
		const { readFileSync } = await import("node:fs");
		const text = readFileSync(outFile, "utf-8");
		try {
			unlinkSync(inFile);
			unlinkSync(outFile);
		} catch {
			// best-effort cleanup
		}
		return { text, numPages: 1 };
	} catch {
		// pdftotext not available, extract raw text streams from PDF
		const raw = params.buffer.toString("binary");
		const textChunks: string[] = [];
		const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
		let match: RegExpExecArray | null;
		while ((match = streamRe.exec(raw)) !== null) {
			const chunk = match[1].replace(/[^\x20-\x7E\n]/g, "").trim();
			if (chunk.length > 10) textChunks.push(chunk);
		}
		return { text: textChunks.join("\n"), numPages: 1 };
	}
}
