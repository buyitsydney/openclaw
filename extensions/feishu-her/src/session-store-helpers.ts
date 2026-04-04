import { readFileSync } from "node:fs";
type SessionEntryLike = Record<string, unknown>;
export function readSessionStoreJson5(storePath: string): { store: Record<string, SessionEntryLike>; ok: boolean } {
	try {
		const raw = readFileSync(storePath, "utf-8");
		let parsed: unknown;
		try { parsed = JSON.parse(raw); } catch {
			parsed = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return { store: parsed as Record<string, SessionEntryLike>, ok: true };
	} catch {}
	return { store: {}, ok: false };
}
