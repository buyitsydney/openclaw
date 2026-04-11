export type ReasoningLevel = "off" | "on" | "stream";
export function normalizeReasoningLevel(raw?: string | null): ReasoningLevel | undefined {
	if (!raw) return undefined;
	const key = raw.toLowerCase();
	if (["off","false","no","0","hide","hidden","disable","disabled"].includes(key)) return "off";
	if (["on","true","yes","1","show","visible","enable","enabled"].includes(key)) return "on";
	if (["stream","streaming","draft","live"].includes(key)) return "stream";
	return undefined;
}
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function matchLevelDirective(body: string, names: string[]): { start: number; end: number; rawLevel?: string } | null {
	const m = body.match(new RegExp(`(?:^|\\s)\\/(?:${names.map(escapeRegExp).join("|")})(?=$|\\s|:)`, "i"));
	if (!m || m.index === undefined) return null;
	let i = m.index + m[0].length;
	while (i < body.length && /\s/.test(body[i])) i++;
	if (body[i] === ":") { i++; while (i < body.length && /\s/.test(body[i])) i++; }
	const a = i; while (i < body.length && /[A-Za-z-]/.test(body[i])) i++;
	return { start: m.index, end: i, rawLevel: i > a ? body.slice(a, i) : undefined };
}
export function extractReasoningDirective(body?: string): {
	cleaned: string; reasoningLevel?: ReasoningLevel; rawLevel?: string; hasDirective: boolean;
} {
	if (!body) return { cleaned: "", hasDirective: false };
	const match = matchLevelDirective(body, ["reasoning", "reason"]);
	if (!match) return { cleaned: body.trim(), hasDirective: false };
	const cleaned = body.slice(0, match.start).concat(" ").concat(body.slice(match.end)).replace(/\s+/g, " ").trim();
	return { cleaned, reasoningLevel: normalizeReasoningLevel(match.rawLevel), rawLevel: match.rawLevel, hasDirective: true };
}
