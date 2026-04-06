// Dynamic import to avoid rolldown bundling simple-xml-to-json (ESM export issue)
async function loadOfficeParser() {
	const mod = await import("officeparser");
	return mod.parseOfficeAsync;
}

export async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
	const trimmed = base64.trim();
	if (!trimmed) return undefined;
	const take = Math.min(256, trimmed.length);
	const sliceLen = take - (take % 4);
	if (sliceLen < 8) return undefined;
	try {
		const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
		if (head.length < 4) return undefined;
		if (head[0]===0x89&&head[1]===0x50&&head[2]===0x4e&&head[3]===0x47) return "image/png";
		if (head[0]===0xff&&head[1]===0xd8&&head[2]===0xff) return "image/jpeg";
		if (head[0]===0x47&&head[1]===0x49&&head[2]===0x46) return "image/gif";
		if (head[0]===0x25&&head[1]===0x50&&head[2]===0x44&&head[3]===0x46) return "application/pdf";
		return undefined;
	} catch { return undefined; }
}

type PdfExtractedContent = { text: string; numPages: number };
export async function extractPdfContent(params: {
	buffer: Buffer; maxPages: number; maxPixels: number; minTextChars: number;
	pageNumbers?: number[]; onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent> {
	const parseOfficeAsync = await loadOfficeParser();
	const text = await parseOfficeAsync(params.buffer, { outputFilePath: undefined });
	return { text: typeof text === "string" ? text : String(text), numPages: 1 };
}
