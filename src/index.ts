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
	lineOffset?: number; // 1-based starting file line number (default 1 for full reads)
	lineCount?: number; // number of lines in the original tool result
	path?: string; // file path from the original tool call
	cachedReplacement?: string;
	timestamp: number;
}

interface PendingDecision {
	toolCallId: string;
	toolName: string;
	size: number;
	path?: string;
	lineOffset?: number; // 1-based starting file line number for offset reads
	lineCount?: number; // number of lines in the original tool result
	assistantMessagesSinceMarked: number;
	instructionInjected: boolean;
}

interface MessageTextBlock {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

type TextLikeBlock = MessageTextBlock & { text: string };

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
const SCORING_TASK_START = "[pi-sift scoring task]";
const SCORING_TASK_END = "[/pi-sift scoring task]";
const INVALID_TOOLCALL_ID_REMINDER = "[pi-sift reminder] A previous <context_lens> decision used an invalid toolCallId. Use only the listed toolCallIds exactly; unknown IDs are ignored.";

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SCORING_TASK_BLOCK_REGEX = new RegExp(`${escapeRegex(SCORING_TASK_START)}[\\s\\S]*?${escapeRegex(SCORING_TASK_END)}`, "g");

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

const extractLineRange = (text: string, ranges: [number, number][], firstLine: number = 1): string => {
	const lines = text.split("\n");
	const base = firstLine - 1; // offset to convert file line numbers to 0-based array indices
	const kept: string[] = [];
	for (const [start, end] of ranges) {
		const lo = Math.max(0, start - 1 - base);
		const hi = Math.min(lines.length, end - base);
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
	const { toolCallId, action, summary, keepLines, lineOffset } = payload;
	if (typeof toolCallId !== "string") return null;
	if (action !== "keep" && action !== "summarize") return null;
	if (summary !== undefined && typeof summary !== "string") return null;
	if (keepLines !== undefined && !isValidKeepLines(keepLines)) return null;
	const decision: LensDecision = { toolCallId, action, summary, timestamp: Date.now() };
	if (keepLines !== undefined) decision.keepLines = keepLines as [number, number][];
	if (typeof lineOffset === "number" && lineOffset > 1) decision.lineOffset = lineOffset;
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

const isLegacyScoringInstructionLine = (trimmed: string): boolean => {
	if (trimmed === "") return true;
	if (trimmed.startsWith("Emit one")) return true;
	if (trimmed === "Actions:") return true;
	if (trimmed.startsWith("- keep:")) return true;
	if (trimmed.startsWith("- summarize:")) return true;
	if (trimmed.startsWith("Prefer summarize over keep")) return true;
	if (trimmed.startsWith("Tool results are line-numbered")) return true;
	if (trimmed.startsWith("Only use toolCallIds")) return true;
	if (trimmed.startsWith("Format: <context_lens>")) return true;
	if (trimmed.startsWith("toolCallIds to score:")) return true;
	if (/^- [^:]+: .* \(\d+ chars\)$/.test(trimmed)) return true;
	return false;
};

const stripLegacyScoringTaskBlocks = (text: string): string => {
	const lines = text.split("\n");
	const kept: string[] = [];
	let changed = false;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() !== SCORING_TASK_START) {
			kept.push(lines[i]);
			continue;
		}
		changed = true;
		i++;
		while (i < lines.length && isLegacyScoringInstructionLine(lines[i].trim())) i++;
		i--;
	}

	return changed ? kept.join("\n") : text;
};

const stripBlocks = (text: string): string => {
	const withoutLensBlocks = text.replace(BLOCK_REGEX, "");
	const withoutScoringBlocks = withoutLensBlocks.replace(SCORING_TASK_BLOCK_REGEX, "");
	const withoutLegacyScoringBlocks = stripLegacyScoringTaskBlocks(withoutScoringBlocks);
	return withoutLegacyScoringBlocks.replace(/\n{3,}/g, "\n\n").trim();
};

const isTextLikeBlock = (block: unknown): block is TextLikeBlock => {
	if (!isObject(block)) return false;
	if (typeof block.text !== "string") return false;
	return block.type !== "thinking";
};

const extractTextLikeContent = (content: MessageTextBlock[]): string => {
	const parts: string[] = [];
	for (const block of content) {
		if (!isTextLikeBlock(block)) continue;
		parts.push(block.text);
	}
	return parts.join("\n");
};

const stripBlocksFromTextRuns = (content: MessageTextBlock[]): { changed: boolean; blocks: MessageTextBlock[] } => {
	const blocks: MessageTextBlock[] = [];
	let changed = false;

	for (let i = 0; i < content.length; ) {
		if (!isTextLikeBlock(content[i])) {
			blocks.push(content[i]);
			i++;
			continue;
		}

		const run: TextLikeBlock[] = [];
		let j = i;
		while (j < content.length) {
			const block = content[j];
			if (!isTextLikeBlock(block)) break;
			run.push(block);
			j++;
		}

		const joined = run.map((block) => block.text).join("\n");
		const stripped = stripBlocks(joined);
		if (stripped === joined) {
			blocks.push(...run);
		} else {
			changed = true;
			if (stripped !== "") blocks.push({ ...run[0], text: stripped });
		}

		i = j;
	}

	return { changed, blocks };
};

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
		SCORING_TASK_START,
		"Emit one <context_lens> JSON block for each listed toolCallId, then continue working on the task.",
		"",
		"Actions:",
		"- keep: full content stays in context.",
		"- summarize: replace with a summary. Use keepLines:[[start,end],...] to preserve specific line ranges verbatim — include any lines you may need later.",
		"",
		"Prefer summarize over keep — keeping costs tokens every turn.",
		"Tool results are line-numbered (N<tab>content). Use line numbers for keepLines ranges.",
		"Only use toolCallIds from the list below exactly as written. Do not invent or alter IDs; unknown IDs are invalid and will be ignored.",
		"",
		"Format: <context_lens>{\"toolCallId\":\"...\",\"action\":\"keep|summarize\",\"summary\":\"...\",\"keepLines\":[[start,end],...]}</context_lens>",
		"",
		`toolCallIds to score: ${idList}`,
		itemLines,
		SCORING_TASK_END,
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
	let invalidToolCallIdReminderPending = false;
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
		invalidToolCallIdReminderPending = false;

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

		// Determine starting line number for offset reads (pi's read tool uses 1-based offset)
		const lineOffset = (isObject(event.input) && typeof event.input.offset === "number" && event.input.offset > 0)
			? event.input.offset : 1;

		const text = extractText(event.content);
		const lineCount = text.split("\n").length;

		const canonicalId = canonicalToolCallId(event.toolCallId);
		pendingDecisions.set(canonicalId, {
			toolCallId: canonicalId,
			toolName: event.toolName,
			size,
			path,
			lineOffset: lineOffset > 1 ? lineOffset : undefined,
			lineCount,
			assistantMessagesSinceMarked: 0,
			instructionInjected: false,
		});

		hasMarkedResults = true;
		console.error(`[pi-sift] marking tool_result id=${event.toolCallId} size=${size}`);

		// Add line numbers using file line numbers so the model can make accurate keepLines selections
		const numbered = text.split("\n").map((line, i) => `${lineOffset + i}\t${line}`).join("\n");
		return { content: [{ type: "text" as const, text: numbered }] };
	});

	// Parse and strip <context_lens> blocks from assistant messages, persist decisions.
	// Also apply a deterministic fallback after text-bearing assistant turns when no
	// model decision arrives.
	pi.on("message_end", (event) => {
		if (!config.enabled) return;
		if (event.message.role !== "assistant") return;

		const persistDecision = (decision: LensDecision) => {
			const canonicalId = canonicalToolCallId(decision.toolCallId);
			const pending = pendingDecisions.get(canonicalId);
			const existing = decisions.get(canonicalId);

			if (!pending && !existing) {
				invalidToolCallIdReminderPending = true;
				console.error(`[pi-sift] ignored decision with unknown toolCallId=${canonicalId} action=${decision.action}`);
				return;
			}

			// Carry lineOffset, lineCount, and path from pending decision (not emitted
			// by model) or from existing decision (when model updates an already-known
			// toolCallId). These are used to build accurate replacement headers.
			const normalized: LensDecision = {
				...decision,
				toolCallId: canonicalId,
				timestamp: decision.timestamp || Date.now(),
				...(
					pending?.lineOffset
						? { lineOffset: pending.lineOffset }
						: existing?.lineOffset
							? { lineOffset: existing.lineOffset }
							: {}
				),
				...(
					pending?.lineCount
						? { lineCount: pending.lineCount }
						: existing?.lineCount
							? { lineCount: existing.lineCount }
							: {}
				),
				...(
					pending?.path
						? { path: pending.path }
						: existing?.path
							? { path: existing.path }
							: {}
				),
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
		let hasAssistantText = false;
		if (typeof content === "string") {
			const parsed = parseDecisionsFromText(content);
			for (const decision of parsed) persistDecision(decision);
			hasAssistantText = stripBlocks(content).length > 0;
		} else if (Array.isArray(content)) {
			const textLike = extractTextLikeContent(content as MessageTextBlock[]);
			const parsed = parseDecisionsFromText(textLike);
			for (const decision of parsed) persistDecision(decision);
			hasAssistantText = stripBlocks(textLike).length > 0;
		}

		for (const [id, pending] of pendingDecisions) {
			if (decisions.has(id)) {
				pendingDecisions.delete(id);
				continue;
			}

			if (hasAssistantText) pending.assistantMessagesSinceMarked += 1;
			if (pending.assistantMessagesSinceMarked < 2) continue;

			const fallbackDecision: LensDecision = {
				toolCallId: id,
				action: "keep",
				timestamp: Date.now(),
				...(pending.lineOffset ? { lineOffset: pending.lineOffset } : {}),
				...(pending.lineCount ? { lineCount: pending.lineCount } : {}),
				...(pending.path ? { path: pending.path } : {}),
			};
			decisions.set(id, fallbackDecision);
			pendingDecisions.delete(id);
			if (!config.dryRun) pi.appendEntry(CUSTOM_ENTRY_TYPE, fallbackDecision);
			console.error(`[pi-sift] fallback decision applied id=${id} action=keep`);
		}

		// Strip <context_lens> blocks from the message IN-PLACE so they don't
		// appear in the TUI or get persisted to the session file.
		// Extensions fire before TUI rendering and session persistence.
		if (typeof content === "string") {
			const stripped = stripBlocks(content);
			if (stripped !== content) {
				(event.message as any).content = [{ type: "text", text: stripped }];
			}
		} else if (Array.isArray(content)) {
			const stripped = stripBlocksFromTextRuns(content as MessageTextBlock[]);
			if (stripped.changed) {
				(event.message as any).content = stripped.blocks;
			}
		}
	});

	// Inject scoring instruction for pending results + apply persisted decisions.
	// Strip <context_lens> blocks from all assistant messages (text blocks only,
	// preserving thinking blocks for Anthropic API validation).
	pi.on("context", (event) => {
		if (!config.enabled) return;

		let changed = false;
		let decisionsAppliedThisPass = false;

		// Strip <context_lens> blocks from all assistant messages AND canonicalize
		// tool call IDs so the model sees the same short form used in scoring prompts.
		//
		// Why canonicalize? Some providers (e.g. OpenAI Codex) use compound IDs like
		// "call_XXX|fc_YYY" in toolCall/toolResult pairs. We store decisions under the
		// canonical prefix ("call_XXX") and use that form in scoring instructions.
		// Without rewriting the IDs in context, the model sees the full compound form
		// in the conversation but the short form in the scoring prompt, fails to match
		// them, and silently skips scoring. For providers with simple IDs (e.g. Claude's
		// "toolu_XXX") this is a no-op since canonicalToolCallId returns them unchanged.
		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i];
			if (!isObject(msg)) continue;

			if (msg.role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					const stripped = stripBlocks(content);
					if (stripped !== content) {
						msg.content = [{ type: "text", text: stripped }];
						changed = true;
					}
				} else if (Array.isArray(content)) {
					const stripped = stripBlocksFromTextRuns(content as MessageTextBlock[]);
					if (stripped.changed) {
						msg.content = stripped.blocks as unknown as typeof msg.content;
						changed = true;
					}
					// Canonicalize toolCall IDs in assistant content blocks
					for (const block of msg.content as MessageTextBlock[]) {
						if (block?.type === "toolCall" && typeof block.id === "string") {
							const canonical = canonicalToolCallId(block.id);
							if (canonical !== block.id) {
								block.id = canonical;
								changed = true;
							}
						}
					}
				}
			} else if (msg.role === "toolResult") {
				// Canonicalize the matching toolResult toolCallId
				if (typeof msg.toolCallId === "string") {
					const canonical = canonicalToolCallId(msg.toolCallId);
					if (canonical !== msg.toolCallId) {
						msg.toolCallId = canonical;
						changed = true;
					}
				}
			}
		}

		const appendToLastUserMessage = (text: string) => {
			let injected = false;
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const msg = event.messages[i];
				if (!isObject(msg) || msg.role !== "user") continue;
				const content = msg.content;
				if (typeof content === "string") {
					msg.content = [{ type: "text", text: content }, { type: "text", text }];
				} else if (Array.isArray(content)) {
					(content as MessageTextBlock[]).push({ type: "text", text });
				} else {
					msg.content = [{ type: "text", text }];
				}
				injected = true;
				break;
			}
			if (!injected) {
				event.messages.push({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				});
			}
		};

		if (invalidToolCallIdReminderPending) {
			appendToLastUserMessage(INVALID_TOOLCALL_ID_REMINDER);
			invalidToolCallIdReminderPending = false;
			changed = true;
		}

		const toPrompt = Array.from(pendingDecisions.values()).filter((pending) => !pending.instructionInjected);
		if (toPrompt.length > 0) {
			const instruction = buildScoringInstruction(toPrompt);
			// Push as a separate user message at the end of context so the model
			// sees it right before responding. The context hook operates on a deep
			// copy, so this is ephemeral and not persisted to the session.
			event.messages.push({
				role: "user",
				content: [{ type: "text", text: instruction }],
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
				// Strip N\t line numbers — not needed after scoring
				const text = extractText(msg.content);
				const stripped = stripLineNumbers(text);
				if (stripped !== text) {
					msg.content = [{ type: "text", text: stripped }];
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
				// Build a source header so the model knows exactly which file/lines
				// this replacement covers, even if the model's summary is inaccurate.
				const firstLine = decision.lineOffset || 1;
				const lastLine = decision.lineCount ? firstLine + decision.lineCount - 1 : undefined;
				const sourceDesc = decision.path
					? `${decision.path}${lastLine ? ` lines ${firstLine}-${lastLine}` : ""}`
					: undefined;
				const sourceHeader = sourceDesc ? `[pi-sift summarized: ${sourceDesc}]` : "[pi-sift: summarized]";
				const modelSummary = decision.summary || "";

				if (decision.keepLines && decision.keepLines.length > 0) {
					const originalText = extractText(msg.content);
					const sections: string[] = [];
					for (const [start, end] of decision.keepLines) {
						const raw = extractLineRange(originalText, [[start, end]], firstLine);
						if (raw) sections.push(`--- kept lines ${start}-${end} (verbatim, do not re-read) ---\n${stripLineNumbers(raw)}`);
					}
					const header = modelSummary
						? `${sourceHeader}\n${modelSummary}`
						: sourceHeader;
					replacement = sections.length > 0
						? `${header}\n\n${sections.join("\n\n")}`
						: header;
				} else {
					replacement = modelSummary
						? `${sourceHeader}\n${modelSummary}`
						: sourceHeader;
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
