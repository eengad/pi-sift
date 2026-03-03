import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type LensAction = "keep" | "summarize" | "dismiss";

interface LensConfig {
	enabled: boolean;
	tools: string[];
	minCharsToScore: number;
	editedFileProtectionTurns: number;
	dryRun: boolean;
	stats: boolean;
}

interface LensDecision {
	toolCallId: string;
	action: LensAction;
	summary?: string;
	keepLines?: [number, number][];
	cachedReplacement?: string;
	timestamp: number;
}

interface PendingDecision {
	toolCallId: string;
	toolName: string;
	size: number;
	path?: string;
	assistantMessagesSinceMarked: number;
	instructionInjected: boolean;
}

interface MessageTextBlock {
	type?: string;
	text?: string;
}

const DEFAULT_CONFIG: LensConfig = {
	enabled: true,
	tools: ["read", "grep", "bash"],
	minCharsToScore: 5000,
	editedFileProtectionTurns: 4,
	dryRun: false,
	stats: true,
};

// NOTE: these protocol strings (XML tag, entry type, marker) are persisted in session
// files. Do NOT rename them — it would break existing sessions on reload.
const CUSTOM_ENTRY_TYPE = "context_lens_decision";
const BLOCK_REGEX = /<context_lens>([\s\S]*?)<\/context_lens>/g;
const MARKER_PREFIX = "[CONTEXT_LENS_SCORE:";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
};

const extractTextLength = (content: unknown): number => extractText(content).length;

const stripLineNumbers = (text: string): string =>
	text.split("\n").map(line => {
		const tab = line.indexOf("\t");
		return (tab !== -1 && /^\d+$/.test(line.slice(0, tab))) ? line.slice(tab + 1) : line;
	}).join("\n");

const extractLineRange = (text: string, ranges: [number, number][]): string => {
	const lines = text.split("\n");
	const kept: string[] = [];
	for (const [start, end] of ranges) {
		// 1-based line numbers → 0-based indices
		const lo = Math.max(0, start - 1);
		const hi = Math.min(lines.length, end);
		for (let i = lo; i < hi; i++) {
			kept.push(lines[i]);
		}
	}
	return kept.join("\n");
};

const isValidKeepLines = (value: unknown): value is [number, number][] => {
	if (!Array.isArray(value)) return false;
	for (const item of value) {
		if (!Array.isArray(item) || item.length !== 2) return false;
		if (typeof item[0] !== "number" || typeof item[1] !== "number") return false;
		if (item[0] < 1 || item[1] < item[0]) return false;
	}
	return true;
};

const parseDecisionPayload = (payload: unknown): LensDecision | null => {
	if (!isObject(payload)) return null;
	const { toolCallId, action, summary, keepLines } = payload;
	if (typeof toolCallId !== "string") return null;
	if (action !== "keep" && action !== "summarize") return null;
	if (summary !== undefined && typeof summary !== "string") return null;
	if (keepLines !== undefined && !isValidKeepLines(keepLines)) return null;
	const decision: LensDecision = { toolCallId, action, summary, timestamp: Date.now() };
	if (keepLines !== undefined) decision.keepLines = keepLines as [number, number][];
	return decision;
};

const parseDecisionsFromText = (text: string): LensDecision[] => {
	const decisions: LensDecision[] = [];
	for (const match of text.matchAll(BLOCK_REGEX)) {
		const payload = match[1]?.trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload);
			const decision = parseDecisionPayload(parsed);
			if (decision) decisions.push(decision);
		} catch {
			// fail-safe: ignore malformed block
		}
	}
	return decisions;
};

const stripBlocks = (text: string): string =>
	text.replace(BLOCK_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();

const loadConfig = (): LensConfig => {
	// Also check legacy config path for backwards compatibility
	const configPath = join(homedir(), ".pi", "agent", "pi-sift.json");
	if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isObject(parsed)) return { ...DEFAULT_CONFIG };
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
			tools: Array.isArray(parsed.tools)
				? parsed.tools.filter((t): t is string => typeof t === "string")
				: DEFAULT_CONFIG.tools,
			minCharsToScore:
				typeof parsed.minCharsToScore === "number" ? parsed.minCharsToScore : DEFAULT_CONFIG.minCharsToScore,
			editedFileProtectionTurns:
				typeof parsed.editedFileProtectionTurns === "number"
					? parsed.editedFileProtectionTurns
					: DEFAULT_CONFIG.editedFileProtectionTurns,
			dryRun: typeof parsed.dryRun === "boolean" ? parsed.dryRun : DEFAULT_CONFIG.dryRun,
			stats: typeof parsed.stats === "boolean" ? parsed.stats : DEFAULT_CONFIG.stats,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

const getFilePathFromInput = (input: Record<string, unknown>): string | undefined => {
	if (typeof input.path === "string") return input.path;
	if (typeof input.filePath === "string") return input.filePath;
	return undefined;
};

const canonicalToolCallId = (id: string): string => {
	const pipe = id.indexOf("|");
	return pipe === -1 ? id : id.slice(0, pipe);
};

const buildScoringInstruction = (items: PendingDecision[]): string => {
	const idList = items.map((item) => item.toolCallId).join(", ");
	const itemLines = items
		.map((item) => `- ${item.toolCallId}: ${item.toolName}${item.path ? ` ${item.path}` : ""} (${item.size} chars)`)
		.join("\n");

	return [
		"[pi-sift scoring task]",
		"Emit one <context_lens> JSON block for each listed toolCallId, then continue working on the task.",
		"",
		"Actions:",
		"- keep: full content stays in context.",
		"- summarize: replace with a summary. Use keepLines:[[start,end],...] to preserve specific line ranges verbatim — include any lines you may need later.",
		"",
		"Prefer summarize over keep — keeping costs tokens every turn.",
		"Tool results are line-numbered (N<tab>content). Use line numbers for keepLines ranges.",
		"",
		"Format: <context_lens>{\"toolCallId\":\"...\",\"action\":\"keep|summarize\",\"summary\":\"...\",\"keepLines\":[[start,end],...]}</context_lens>",
		"",
		`toolCallIds to score: ${idList}`,
		itemLines,
	].join("\n");
};

export default function piSift(pi: ExtensionAPI) {
	let config = loadConfig();
	const decisions = new Map<string, LensDecision>();
	const pendingDecisions = new Map<string, PendingDecision>();
	const protectedFiles = new Map<string, number>();
	let currentTurn = 0;
	let totalCharsSaved = 0;
	let decisionsAppliedCount = 0;
	let hasMarkedResults = false;
	const readFileToolCallIds = new Map<string, { id: string; isFullRead: boolean }>(); // path → info

	const rebuildDecisions = (ctx: {
		sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
	}) => {
		decisions.clear();
		pendingDecisions.clear();
		protectedFiles.clear();
		readFileToolCallIds.clear();
		currentTurn = 0;
		totalCharsSaved = 0;
		decisionsAppliedCount = 0;

		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
			const decision = parseDecisionPayload(entry.data);
			if (decision) decisions.set(canonicalToolCallId(decision.toolCallId), decision);
		}
	};

	const shouldProtectFile = (toolName: string, input: Record<string, unknown>): boolean => {
		if (toolName !== "read") return false;
		const path = getFilePathFromInput(input);
		if (!path) return false;
		const editedTurn = protectedFiles.get(path);
		if (editedTurn === undefined) return false;
		return currentTurn - editedTurn <= config.editedFileProtectionTurns;
	};

	const applyHeuristicDismiss = (toolCallId: string, reason: string) => {
		const canonicalId = canonicalToolCallId(toolCallId);
		if (decisions.get(canonicalId)?.action === "dismiss") return; // already dismissed
		const decision: LensDecision = {
			toolCallId: canonicalId,
			action: "dismiss",
			summary: reason,
			timestamp: Date.now(),
		};
		decisions.set(canonicalId, decision);
		pendingDecisions.delete(canonicalId);
		if (!config.dryRun) pi.appendEntry(CUSTOM_ENTRY_TYPE, decision);
		console.error(`[pi-sift] heuristic dismiss id=${canonicalId} reason=${reason}`);
	};

	pi.registerCommand("sift-stats", {
		description: "Show basic pi-sift runtime stats",
		handler: async (_args, ctx) => {
			const lines = [
				`enabled=${String(config.enabled)}`,
				`decisions=${decisions.size} (${decisionsAppliedCount} applied)`,
				`chars saved≈${totalCharsSaved}`,
			];
			ctx.ui.notify(`[pi-sift] ${lines.join(" | ")}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		rebuildDecisions(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		config = loadConfig();
		rebuildDecisions(ctx);
	});

	pi.on("turn_start", (event) => {
		currentTurn = event.turnIndex;
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (!isObject(event.args)) return;
		const path = getFilePathFromInput(event.args);
		if (!path) return;
		protectedFiles.set(path, currentTurn);

		// Auto-dismiss any earlier read of this file (content is now stale).
		// Skip if the read has a summarize+keepLines decision — the kept lines are a small
		// subset (like baseline's full stale content) and preserve context the model needs.
		const previousRead = readFileToolCallIds.get(path);
		if (previousRead) {
			const prevDecision = decisions.get(previousRead.id);
			const hasKeepLines = prevDecision?.action === "summarize" && prevDecision.keepLines?.length;
			if (!hasKeepLines) {
				applyHeuristicDismiss(previousRead.id, `stale after edit of ${path}`);
				readFileToolCallIds.delete(path);
			}
		}
	});

	// Mark large tool results inline so the model sees the scoring request
	pi.on("tool_result", (event) => {
		if (!config.enabled) return;
		if (event.isError) return;
		if (!config.tools.includes(event.toolName)) return;
		if (shouldProtectFile(event.toolName, event.input)) return;

		const path = isObject(event.input) ? getFilePathFromInput(event.input) : undefined;

		// Auto-dismiss old read when a file is re-read, but only if the old read was full-file.
		// Skip if the old read already has a summarize+keepLines decision — that content is
		// already compressed and the kept lines are valuable, so don't throw them away.
		// Only applies to "read" tool — grep/bash paths are search directories, not file content.
		// Runs before the size threshold — dismissing the old read doesn't depend on the new read's size.
		if (path && event.toolName === "read") {
			const previous = readFileToolCallIds.get(path);
			if (previous?.isFullRead) {
				const prevDecision = decisions.get(previous.id);
				const hasKeepLines = prevDecision?.action === "summarize" && prevDecision.keepLines?.length;
				if (!hasKeepLines) {
					applyHeuristicDismiss(previous.id, `superseded by re-read of ${path}`);
				}
			}
		}

		const size = extractTextLength(event.content);
		if (size < config.minCharsToScore) return;

		// Only track read results large enough to score
		const hasOffset = isObject(event.input) && (event.input.offset !== undefined || event.input.line !== undefined);
		if (path && event.toolName === "read") {
			readFileToolCallIds.set(path, { id: canonicalToolCallId(event.toolCallId), isFullRead: !hasOffset });
		}

		const canonicalId = canonicalToolCallId(event.toolCallId);
		pendingDecisions.set(canonicalId, {
			toolCallId: canonicalId,
			toolName: event.toolName,
			size,
			path,
			assistantMessagesSinceMarked: 0,
			instructionInjected: false,
		});

		// Prepend lightweight marker inline; scoring instruction is injected via context hook.
		const marker = `${MARKER_PREFIX}${event.toolCallId}] This result is ${size} chars.\n\n`;

		hasMarkedResults = true;
		console.error(`[pi-sift] marking tool_result id=${event.toolCallId} size=${size}`);

		const text = extractText(event.content);
		// Add line numbers so the model can make accurate keepLines selections
		const numbered = text.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
		return { content: [{ type: "text" as const, text: marker + numbered }] };
	});

	// Parse and strip <context_lens> blocks from assistant messages, persist decisions.
	// Also apply a deterministic fallback so tool-call-only loops still get decisions.
	pi.on("message_end", (event) => {
		if (!config.enabled) return;
		if (event.message.role !== "assistant") return;

		const persistDecision = (decision: LensDecision) => {
			const canonicalId = canonicalToolCallId(decision.toolCallId);
			const normalized: LensDecision = {
				...decision,
				toolCallId: canonicalId,
				timestamp: decision.timestamp || Date.now(),
			};
			decisions.set(canonicalId, normalized);
			pendingDecisions.delete(canonicalId);
			if (!config.dryRun) {
				// Persist keepLines but not cachedReplacement (runtime-only cache)
				const { cachedReplacement: _, ...persisted } = normalized;
				pi.appendEntry(CUSTOM_ENTRY_TYPE, persisted);
			}
		};

		const content = event.message.content;
		if (typeof content === "string") {
			const parsed = parseDecisionsFromText(content);
			for (const decision of parsed) persistDecision(decision);
		} else if (Array.isArray(content)) {
			for (const block of content as MessageTextBlock[]) {
				if (block?.type !== "text" || typeof block.text !== "string") continue;
				const parsed = parseDecisionsFromText(block.text);
				for (const decision of parsed) persistDecision(decision);
			}
		}

		for (const [id, pending] of pendingDecisions) {
			if (decisions.has(id)) {
				pendingDecisions.delete(id);
				continue;
			}

			pending.assistantMessagesSinceMarked += 1;
			if (pending.assistantMessagesSinceMarked < 2) continue;

			const fallbackDecision: LensDecision = {
				toolCallId: id,
				action: "keep",
				timestamp: Date.now(),
			};
			decisions.set(id, fallbackDecision);
			pendingDecisions.delete(id);
			if (!config.dryRun) pi.appendEntry(CUSTOM_ENTRY_TYPE, fallbackDecision);
			console.error(`[pi-sift] fallback decision applied id=${id} action=keep`);
		}
	});

	// Inject scoring instruction for pending results + apply persisted decisions.
	// Also strip <context_lens> blocks from older assistant messages to avoid
	// leaking scoring metadata into the context window. The LAST assistant
	// message is left untouched because the Anthropic API validates thinking
	// block integrity for that message.
	pi.on("context", (event) => {
		if (!config.enabled) return;

		let changed = false;
		let decisionsAppliedThisPass = false;

		// Strip <context_lens> blocks from all assistant messages except the last one.
		let lastAssistantIdx = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (isObject(event.messages[i]) && event.messages[i].role === "assistant") {
				lastAssistantIdx = i;
				break;
			}
		}
		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i];
			if (!isObject(msg) || msg.role !== "assistant" || i === lastAssistantIdx) continue;
			const content = msg.content;
			if (typeof content === "string") {
				const stripped = stripBlocks(content);
				if (stripped !== content) {
					msg.content = [{ type: "text", text: stripped }];
					changed = true;
				}
			} else if (Array.isArray(content)) {
				let blockChanged = false;
				for (const block of content as MessageTextBlock[]) {
					if (block?.type !== "text" || typeof block.text !== "string") continue;
					const stripped = stripBlocks(block.text);
					if (stripped !== block.text) {
						block.text = stripped;
						blockChanged = true;
					}
				}
				if (blockChanged) {
					// Remove empty text blocks that resulted from stripping
					msg.content = (content as unknown as MessageTextBlock[]).filter(
						(block) => block.type !== "text" || (typeof block.text === "string" && block.text !== ""),
					) as unknown as typeof msg.content;
					changed = true;
				}
			}
		}

		const toPrompt = Array.from(pendingDecisions.values()).filter((pending) => !pending.instructionInjected);
		if (toPrompt.length > 0) {
			event.messages.push({
				role: "user",
				content: [{ type: "text", text: buildScoringInstruction(toPrompt) }],
				timestamp: Date.now(),
			});
			for (const pending of toPrompt) pending.instructionInjected = true;
			changed = true;
		}

		for (const msg of event.messages) {
			if (!isObject(msg) || msg.role !== "toolResult") continue;
			const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
			if (!toolCallId) continue;

			const decision = decisions.get(canonicalToolCallId(toolCallId));
			if (!decision) continue;

			if (decision.action === "keep") {
				// Strip scoring marker and N\t line numbers — not needed after scoring
				const text = extractText(msg.content);
				const markerEnd = text.indexOf(MARKER_PREFIX) === 0
					? text.indexOf("\n\n", MARKER_PREFIX.length)
					: -1;
				if (markerEnd !== -1) {
					msg.content = [{ type: "text", text: stripLineNumbers(text.slice(markerEnd + 2)) }];
					changed = true;
				}
				continue;
			}

			let replacement: string;
			if (decision.action === "dismiss") {
				replacement = `[pi-sift dismissed: ${decision.summary || "not relevant"}]`;
			} else if (decision.cachedReplacement) {
				replacement = decision.cachedReplacement;
			} else {
				const baseSummary = decision.summary || "[pi-sift: summarized]";
				if (decision.keepLines && decision.keepLines.length > 0) {
					let originalText = extractText(msg.content);
					// Strip the CONTEXT_LENS_SCORE marker so line numbers match the original file
					const markerEnd = originalText.indexOf(MARKER_PREFIX) === 0
						? originalText.indexOf("\n\n", MARKER_PREFIX.length)
						: -1;
					if (markerEnd !== -1) originalText = originalText.slice(markerEnd + 2);
					const sections: string[] = [];
					for (const [start, end] of decision.keepLines) {
						const raw = extractLineRange(originalText, [[start, end]]);
						if (raw) sections.push(`--- kept lines ${start}-${end} ---\n${stripLineNumbers(raw)}`);
					}
					replacement = sections.length > 0
						? `${baseSummary}\n\n${sections.join("\n\n")}`
						: baseSummary;
				} else {
					replacement = baseSummary;
				}
				decision.cachedReplacement = replacement;
			}

			const originalLength = extractTextLength(msg.content);
			if (originalLength <= replacement.length) continue;

			msg.content = [{ type: "text", text: replacement }];
			totalCharsSaved += Math.max(0, originalLength - replacement.length);
			decisionsAppliedThisPass = true;
			changed = true;
		}

		if (decisionsAppliedThisPass) decisionsAppliedCount++;
		if (changed) return { messages: event.messages };
	});
}

// Re-export helpers for testing
export { extractTextLength, extractLineRange, stripLineNumbers, parseDecisionPayload, parseDecisionsFromText, stripBlocks, extractText, buildScoringInstruction };
