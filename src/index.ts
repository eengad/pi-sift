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

const parseDecisionPayload = (payload: unknown): LensDecision | null => {
	if (!isObject(payload)) return null;
	const { toolCallId, action, summary } = payload;
	if (typeof toolCallId !== "string") return null;
	if (action !== "keep" && action !== "summarize" && action !== "dismiss") return null;
	if (summary !== undefined && typeof summary !== "string") return null;
	return { toolCallId, action, summary, timestamp: Date.now() };
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
		"Format: <context_lens>{\"toolCallId\":\"...\",\"action\":\"keep|summarize|dismiss\",\"summary\":\"...\"}</context_lens>",
		"",
		"Actions:",
		"- keep: full content should stay.",
		"- summarize: compress to 2-4 lines with key details.",
		"- dismiss: not relevant (one-line reason).",
		"",
		"Prefer summarize or dismiss — keeping costs tokens every turn; re-reading is cheap.",
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

		// Auto-dismiss any earlier read of this file (content is now stale)
		const previousRead = readFileToolCallIds.get(path);
		if (previousRead) {
			applyHeuristicDismiss(previousRead.id, `stale after edit of ${path}`);
			readFileToolCallIds.delete(path);
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
		// Only applies to "read" tool — grep/bash paths are search directories, not file content.
		// Runs before the size threshold — dismissing the old read doesn't depend on the new read's size.
		if (path && event.toolName === "read") {
			const previous = readFileToolCallIds.get(path);
			if (previous?.isFullRead) {
				applyHeuristicDismiss(previous.id, `superseded by re-read of ${path}`);
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
		return { content: [{ type: "text" as const, text: marker + text }] };
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
			if (!config.dryRun) pi.appendEntry(CUSTOM_ENTRY_TYPE, normalized);
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
			if (!decision || decision.action === "keep") continue;

			const summary =
				decision.action === "dismiss"
					? `[pi-sift dismissed: ${decision.summary || "not relevant"}]`
					: decision.summary || "[pi-sift: summarized]";

			const originalLength = extractTextLength(msg.content);
			if (originalLength <= summary.length) continue;

			msg.content = [{ type: "text", text: summary }];
			totalCharsSaved += Math.max(0, originalLength - summary.length);
			decisionsAppliedThisPass = true;
			changed = true;
		}

		if (decisionsAppliedThisPass) decisionsAppliedCount++;
		if (changed) return { messages: event.messages };
	});
}

// Re-export helpers for testing
export { extractTextLength, parseDecisionPayload, parseDecisionsFromText, stripBlocks, extractText, buildScoringInstruction };
