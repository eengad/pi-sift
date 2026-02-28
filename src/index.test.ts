/**
 * Unit tests for pi-context-lens pure functions.
 *
 * Uses node:test — run with: npx tsx --test src/index.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Re-export the pure functions for testing.
// Since index.ts exports only the default factory, we extract the helpers here
// by duplicating the logic. In a future refactor these should move to a shared module.

const BLOCK_REGEX = /<context_lens>([\s\S]*?)<\/context_lens>/g;

type LensAction = "keep" | "summarize" | "dismiss";

interface LensDecision {
	toolCallId: string;
	action: LensAction;
	summary?: string;
	timestamp: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const extractTextLength = (content: unknown): number => {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") total += part.text.length;
	}
	return total;
};

const parseDecisionPayload = (payload: unknown): LensDecision | null => {
	if (!isObject(payload)) return null;
	const { toolCallId, action, summary } = payload;
	if (typeof toolCallId !== "string") return null;
	if (action !== "keep" && action !== "summarize" && action !== "dismiss") return null;
	if (summary !== undefined && typeof summary !== "string") return null;
	return { toolCallId, action: action as LensAction, summary: summary as string | undefined, timestamp: Date.now() };
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
			// ignore
		}
	}
	return decisions;
};

const stripBlocks = (text: string): string =>
	text.replace(BLOCK_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe("extractTextLength", () => {
	it("handles plain string", () => {
		assert.equal(extractTextLength("hello"), 5);
	});

	it("handles content array", () => {
		const content = [
			{ type: "text", text: "hello" },
			{ type: "text", text: " world" },
		];
		assert.equal(extractTextLength(content), 11);
	});

	it("skips non-text blocks", () => {
		const content = [
			{ type: "text", text: "abc" },
			{ type: "image", data: "..." },
			{ type: "text", text: "def" },
		];
		assert.equal(extractTextLength(content), 6);
	});

	it("returns 0 for null/undefined", () => {
		assert.equal(extractTextLength(null), 0);
		assert.equal(extractTextLength(undefined), 0);
	});

	it("returns 0 for empty array", () => {
		assert.equal(extractTextLength([]), 0);
	});
});

describe("parseDecisionPayload", () => {
	it("parses valid keep decision", () => {
		const d = parseDecisionPayload({ toolCallId: "tc1", action: "keep" });
		assert.ok(d);
		assert.equal(d.toolCallId, "tc1");
		assert.equal(d.action, "keep");
		assert.equal(d.summary, undefined);
	});

	it("parses valid summarize decision", () => {
		const d = parseDecisionPayload({ toolCallId: "tc2", action: "summarize", summary: "short version" });
		assert.ok(d);
		assert.equal(d.action, "summarize");
		assert.equal(d.summary, "short version");
	});

	it("parses valid dismiss decision", () => {
		const d = parseDecisionPayload({ toolCallId: "tc3", action: "dismiss", summary: "not relevant" });
		assert.ok(d);
		assert.equal(d.action, "dismiss");
	});

	it("rejects missing toolCallId", () => {
		assert.equal(parseDecisionPayload({ action: "keep" }), null);
	});

	it("rejects invalid action", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc1", action: "delete" }), null);
	});

	it("rejects non-string summary", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc1", action: "summarize", summary: 42 }), null);
	});

	it("rejects non-object input", () => {
		assert.equal(parseDecisionPayload("string"), null);
		assert.equal(parseDecisionPayload(null), null);
		assert.equal(parseDecisionPayload(42), null);
	});
});

describe("parseDecisionsFromText", () => {
	it("parses single block", () => {
		const text = 'Some response <context_lens>{"toolCallId":"tc1","action":"dismiss","summary":"irrelevant"}</context_lens> more text';
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 1);
		assert.equal(decisions[0]!.toolCallId, "tc1");
		assert.equal(decisions[0]!.action, "dismiss");
	});

	it("parses multiple blocks", () => {
		const text = [
			'<context_lens>{"toolCallId":"tc1","action":"keep"}</context_lens>',
			'<context_lens>{"toolCallId":"tc2","action":"summarize","summary":"utils"}</context_lens>',
		].join("\n");
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 2);
	});

	it("ignores malformed JSON", () => {
		const text = "<context_lens>not json</context_lens>";
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 0);
	});

	it("ignores empty block", () => {
		const text = "<context_lens></context_lens>";
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 0);
	});

	it("ignores blocks with invalid schema", () => {
		const text = '<context_lens>{"toolCallId":"tc1","action":"nuke"}</context_lens>';
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 0);
	});

	it("returns empty for text without blocks", () => {
		const decisions = parseDecisionsFromText("just normal assistant text");
		assert.equal(decisions.length, 0);
	});

	it("handles multiline JSON in block", () => {
		const text = `<context_lens>
{
  "toolCallId": "tc1",
  "action": "summarize",
  "summary": "helper functions"
}
</context_lens>`;
		const decisions = parseDecisionsFromText(text);
		assert.equal(decisions.length, 1);
		assert.equal(decisions[0]!.summary, "helper functions");
	});
});

describe("stripBlocks", () => {
	it("removes single block", () => {
		const text = 'before <context_lens>{"a":1}</context_lens> after';
		assert.equal(stripBlocks(text), "before  after");
	});

	it("removes multiple blocks", () => {
		const text = '<context_lens>a</context_lens> middle <context_lens>b</context_lens>';
		assert.equal(stripBlocks(text), "middle");
	});

	it("collapses excessive newlines", () => {
		const text = 'before\n\n\n<context_lens>x</context_lens>\n\n\nafter';
		assert.equal(stripBlocks(text), "before\n\nafter");
	});

	it("returns trimmed text when no blocks", () => {
		assert.equal(stripBlocks("  hello  "), "hello");
	});
});
