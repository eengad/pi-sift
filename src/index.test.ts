import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTextLength, extractLineRange, stripLineNumbers, parseDecisionPayload, parseDecisionsFromText, stripBlocks, extractText, buildScoringInstruction } from "./index.js";

describe("extractTextLength", () => {
	it("handles plain string", () => { assert.equal(extractTextLength("hello"), 5); });
	it("handles content array", () => { assert.equal(extractTextLength([{ type: "text", text: "hello world" }]), 11); });
	it("skips non-text blocks", () => { assert.equal(extractTextLength([{ type: "image", source: "abc" }, { type: "text", text: "hi" }]), 2); });
	it("returns 0 for null/undefined", () => { assert.equal(extractTextLength(null), 0); assert.equal(extractTextLength(undefined), 0); });
	it("returns 0 for empty array", () => { assert.equal(extractTextLength([]), 0); });
});

describe("extractText", () => {
	it("extracts from string", () => { assert.equal(extractText("hello"), "hello"); });
	it("extracts from content array", () => { assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb"); });
	it("returns empty for non-array/string", () => { assert.equal(extractText(42), ""); });
});

describe("parseDecisionPayload", () => {
	it("parses valid keep", () => { const d = parseDecisionPayload({ toolCallId: "tc-1", action: "keep" }); assert.ok(d); assert.equal(d.action, "keep"); });
	it("parses valid summarize", () => { const d = parseDecisionPayload({ toolCallId: "tc-2", action: "summarize", summary: "Short" }); assert.ok(d); assert.equal(d.summary, "Short"); });
	it("rejects dismiss action (model cannot dismiss)", () => { assert.equal(parseDecisionPayload({ toolCallId: "tc-3", action: "dismiss", summary: "Not relevant" }), null); });
	it("rejects missing toolCallId", () => { assert.equal(parseDecisionPayload({ action: "keep" }), null); });
	it("rejects invalid action", () => { assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "remove" }), null); });
	it("rejects non-string summary", () => { assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", summary: 123 }), null); });
	it("rejects non-object", () => { assert.equal(parseDecisionPayload("nope"), null); assert.equal(parseDecisionPayload(null), null); });
});

describe("parseDecisionsFromText", () => {
	it("parses single block", () => {
		const d = parseDecisionsFromText('text <context_lens>{"toolCallId":"tc-1","action":"keep"}</context_lens> more');
		assert.equal(d.length, 1);
		assert.equal(d[0].action, "keep");
	});
	it("parses multiple blocks", () => {
		const d = parseDecisionsFromText('<context_lens>{"toolCallId":"a","action":"keep"}</context_lens><context_lens>{"toolCallId":"b","action":"summarize","summary":"x"}</context_lens>');
		assert.equal(d.length, 2);
	});
	it("ignores malformed JSON", () => { assert.equal(parseDecisionsFromText("<context_lens>not json</context_lens>").length, 0); });
	it("ignores empty block", () => { assert.equal(parseDecisionsFromText("<context_lens></context_lens>").length, 0); });
	it("ignores invalid schema", () => { assert.equal(parseDecisionsFromText('<context_lens>{"action":"nope"}</context_lens>').length, 0); });
	it("returns empty for no blocks", () => { assert.equal(parseDecisionsFromText("just text").length, 0); });
	it("handles multiline JSON", () => {
		const d = parseDecisionsFromText('<context_lens>{\n"toolCallId":"tc-1",\n"action":"summarize",\n"summary":"test"\n}</context_lens>');
		assert.equal(d.length, 1);
	});
});

describe("stripBlocks", () => {
	it("removes single block", () => { assert.equal(stripBlocks("before <context_lens>{}</context_lens> after"), "before  after"); });
	it("removes multiple", () => { assert.ok(!stripBlocks("<context_lens>a</context_lens><context_lens>b</context_lens>").includes("context_lens")); });
	it("collapses newlines", () => { assert.ok(!stripBlocks("a\n\n\n\n\nb").includes("\n\n\n")); });
	it("trims", () => { assert.equal(stripBlocks("  text  "), "text"); });
});

describe("Mode A inline scoring flow", () => {
	it("marks large tool results and strips decisions from responses", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		// session_start
		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// No before_agent_start — scoring instructions are inline with markers now

		// tool_result with large content — should add line numbers
		let trResult: any;
		for (const h of handlers.get("tool_result") || []) {
			trResult = h({
				type: "tool_result", toolCallId: "tc-1", toolName: "read",
				input: { path: "/big/file.py" }, content: [{ type: "text", text: "x".repeat(5000) }], isError: false,
			}, {});
		}
		assert.ok(trResult);
		const markedText = trResult.content[0].text;
		// No marker prefix — just line-numbered content
		assert.ok(markedText.startsWith("1\t"));
		assert.ok(markedText.includes("x".repeat(100))); // original content preserved

		// context hook should inject scoring instruction in control message lane
		const scoringMsgs = [
			{ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "x".repeat(5000) }] },
		];
		let scoringCtx: any;
		for (const h of handlers.get("context") || []) {
			scoringCtx = h({ messages: scoringMsgs }, {});
		}
		assert.ok(scoringCtx);
		const injected = scoringCtx.messages[scoringCtx.messages.length - 1];
		assert.equal(injected.role, "user");
		assert.ok(String(injected.content[0].text).includes("toolCallIds to score: tc-1"));

		// message_end with context_lens block — should parse & persist but NOT strip content
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: 'Here is my analysis.\n\n<context_lens>{"toolCallId":"tc-1","action":"summarize","summary":"Big file with 5 classes."}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		// message_end strips <context_lens> blocks in-place (before TUI rendering and session persistence)
		assert.ok(!assistantMsg.content[0].text.includes("context_lens"), "message_end must strip context_lens blocks");
		assert.ok(assistantMsg.content[0].text.includes("analysis"));
		assert.equal(appended.length, 1);
		assert.equal((appended[0].data as any).action, "summarize");

		// context hook — should replace tc-1 with summary AND strip blocks from older assistant msgs
		const contextMsgs = [
			{ role: "user", content: [{ type: "text", text: "do something" }] },
			// older assistant message with leftover context_lens block
			{ role: "assistant", content: [{ type: "text", text: 'Analysis.\n\n<context_lens>{"toolCallId":"tc-1","action":"summarize","summary":"Big file with 5 classes."}</context_lens>' }] },
			{ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "x".repeat(5000) }] },
			// latest assistant message — must NOT be stripped
			{ role: "assistant", content: [{ type: "text", text: 'Latest reply <context_lens>{"toolCallId":"tc-99","action":"keep"}</context_lens>' }] },
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.ok(ctxResult);
		// tool result replaced with summary
		assert.equal(ctxResult.messages[2].content[0].text, "Big file with 5 classes.");
		// older assistant message stripped
		assert.ok(!ctxResult.messages[1].content[0].text.includes("context_lens"), "older assistant msg should be stripped");
		assert.ok(ctxResult.messages[1].content[0].text.includes("Analysis"), "non-block text preserved");
		// latest assistant message also stripped now
		assert.ok(!ctxResult.messages[3].content[0].text.includes("context_lens"), "latest assistant msg should also be stripped");
		assert.ok(ctxResult.messages[3].content[0].text.includes("Latest reply"), "non-block text preserved in latest msg");
	});

	it("preserves thinking blocks in latest assistant message", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// Simulate extended-thinking assistant message: [thinking, text_with_block, thinking, text]
		const thinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Let me analyze this..." },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-5","action":"summarize","summary":"irrelevant"}</context_lens>' },
				{ type: "thinking", thinking: "Now continuing..." },
				{ type: "text", text: "Final answer here." },
			],
		};

		// message_end should parse the decision and strip <context_lens> blocks in-place
		for (const h of handlers.get("message_end") || []) {
			h({ message: thinkingMsg }, {});
		}
		assert.equal(appended.length, 1, "decision parsed and persisted");
		assert.equal((appended[0].data as any).action, "summarize");
		// Thinking blocks preserved, empty text block removed, non-empty text block kept
		assert.equal(thinkingMsg.content.length, 3, "empty text block removed after stripping");
		assert.equal(thinkingMsg.content[0].type, "thinking");
		assert.equal(thinkingMsg.content[1].type, "thinking");
		assert.equal(thinkingMsg.content[2].text, "Final answer here.");

		// context handler: older assistant with thinking blocks gets stripped; latest does not
		const olderThinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "old thinking" },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-old","action":"keep"}</context_lens>' },
				{ type: "thinking", thinking: "more old thinking" },
				{ type: "text", text: "old answer" },
			],
		};
		const latestThinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "latest thinking" },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-new","action":"keep"}</context_lens> result' },
			],
		};
		const contextMsgs = [
			{ role: "user", content: [{ type: "text", text: "question" }] },
			olderThinkingMsg,
			{ role: "user", content: [{ type: "text", text: "follow up" }] },
			latestThinkingMsg,
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.ok(ctxResult, "context handler returned modified messages");

		// Older assistant: text blocks stripped, empty ones removed, thinking blocks untouched
		const olderContent = ctxResult.messages[1].content;
		const olderThinkingBlocks = olderContent.filter((b: any) => b.type === "thinking");
		assert.equal(olderThinkingBlocks.length, 2, "thinking blocks preserved in older msg");
		const olderTextBlocks = olderContent.filter((b: any) => b.type === "text");
		for (const block of olderTextBlocks) {
			assert.ok(!block.text.includes("context_lens"), "context_lens stripped from older msg text blocks");
		}
		// The first text block was only context_lens content → should be removed as empty
		assert.equal(olderTextBlocks.length, 1, "empty text block removed after stripping");
		assert.equal(olderTextBlocks[0].text, "old answer");

		// Latest assistant: thinking blocks untouched, text blocks stripped
		const latestContent = ctxResult.messages[3].content;
		assert.equal(latestContent[0].type, "thinking");
		const latestTextBlocks = latestContent.filter((b: any) => b.type === "text");
		for (const block of latestTextBlocks) {
			assert.ok(!block.text.includes("context_lens"), "context_lens stripped from latest msg text blocks");
		}
		// The text block was "<context_lens>...</context_lens> result" → stripped to "result"
		assert.equal(latestTextBlocks.length, 1, "text block with remaining content preserved");
		assert.ok(latestTextBlocks[0].text.includes("result"), "non-block text preserved in latest msg");
	});

	it("falls back to deterministic keep when assistant does tool-call-only turns", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		for (const h of handlers.get("tool_result") || []) {
			h({
				type: "tool_result",
				toolCallId: "tc-auto-1|fc_suffix",
				toolName: "read",
				input: { path: "/tmp/huge.py" },
				content: [{ type: "text", text: "x".repeat(6000) }],
				isError: false,
			}, {});
		}

		const assistantMsg1 = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "foo.py" } }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg1 }, {});
		}
		// After 1 assistant message, fallback should NOT fire yet (context hook needs a turn)
		assert.equal(appended.length, 0);

		const assistantMsg2 = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "bar.py" } }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg2 }, {});
		}

		assert.equal(appended.length, 1);
		const decision = appended[0].data as any;
		assert.equal(decision.toolCallId, "tc-auto-1");
		assert.equal(decision.action, "keep");
		assert.equal(decision.summary, undefined);

		const contextMsgs = [
			{ role: "toolResult", toolCallId: "tc-auto-1|fc_suffix", content: [{ type: "text", text: "x".repeat(6000) }] },
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.equal(ctxResult, undefined);
		assert.equal((contextMsgs[0] as any).content[0].text.length, 6000);
	});
});

describe("stripLineNumbers", () => {
	it("strips N\\t prefixes", () => {
		const input = "1\thello\n2\tworld\n3\t";
		assert.equal(stripLineNumbers(input), "hello\nworld\n");
	});
	it("leaves plain lines untouched", () => {
		const input = "hello\nworld";
		assert.equal(stripLineNumbers(input), "hello\nworld");
	});
	it("leaves non-numeric prefixes untouched", () => {
		const input = "abc\thello\n2\tworld";
		assert.equal(stripLineNumbers(input), "abc\thello\nworld");
	});
});

describe("extractLineRange", () => {
	const plainText = [
		"function hello() {",
		"  console.log('hi');",
		"}",
		"",
		"function world() {",
		"  return 42;",
		"}",
	].join("\n");

	it("extracts a single range", () => {
		const result = extractLineRange(plainText, [[1, 3]]);
		assert.ok(result.includes("function hello()"));
		assert.ok(result.includes("console.log"));
		assert.ok(result.includes("}"));
		assert.ok(!result.includes("function world()"));
	});

	it("extracts multiple ranges", () => {
		const result = extractLineRange(plainText, [[1, 1], [5, 7]]);
		assert.ok(result.includes("function hello()"));
		assert.ok(!result.includes("console.log"));
		assert.ok(result.includes("function world()"));
		assert.ok(result.includes("return 42"));
	});

	it("returns empty string for out-of-range lines", () => {
		assert.equal(extractLineRange(plainText, [[100, 200]]), "");
	});

	it("handles single-line text", () => {
		assert.equal(extractLineRange("only line", [[1, 1]]), "only line");
	});

	it("clamps to end of text", () => {
		const result = extractLineRange(plainText, [[6, 100]]);
		assert.ok(result.includes("return 42"));
		assert.ok(result.includes("}"));
		assert.equal(result.split("\n").length, 2);
	});

	it("handles offset reads with firstLine parameter", () => {
		// Simulate an offset read starting at file line 200
		// The text has 7 lines, representing file lines 200-206
		const result = extractLineRange(plainText, [[200, 202]], 200);
		assert.ok(result.includes("function hello()"));
		assert.ok(result.includes("console.log"));
		assert.ok(result.includes("}"));
		assert.ok(!result.includes("function world()"));
	});

	it("handles multiple ranges with firstLine parameter", () => {
		const result = extractLineRange(plainText, [[200, 200], [204, 206]], 200);
		assert.ok(result.includes("function hello()"));
		assert.ok(!result.includes("console.log"));
		assert.ok(result.includes("function world()"));
		assert.ok(result.includes("return 42"));
	});

	it("returns empty for out-of-range with firstLine", () => {
		assert.equal(extractLineRange(plainText, [[1, 3]], 200), "");
	});
});

describe("parseDecisionPayload keepLines validation", () => {
	it("accepts valid keepLines", () => {
		const d = parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", summary: "Short", keepLines: [[1, 10], [20, 30]] });
		assert.ok(d);
		assert.deepEqual(d.keepLines, [[1, 10], [20, 30]]);
	});

	it("accepts summarize without keepLines", () => {
		const d = parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", summary: "Short" });
		assert.ok(d);
		assert.equal(d.keepLines, undefined);
	});

	it("rejects non-array keepLines", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", keepLines: "bad" }), null);
	});

	it("rejects keepLines with non-tuple items", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", keepLines: [[1]] }), null);
	});

	it("rejects keepLines with non-number values", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", keepLines: [["a", "b"]] }), null);
	});

	it("rejects keepLines where start < 1", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", keepLines: [[0, 5]] }), null);
	});

	it("rejects keepLines where end < start", () => {
		assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", keepLines: [[10, 5]] }), null);
	});
});

describe("keepLines in summarize flow", () => {
	it("summarize with keepLines preserves correct lines", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// Build plain text content (large enough to score)
		const plainLines: string[] = [];
		for (let i = 1; i <= 200; i++) {
			plainLines.push(`line ${i} content here padding${"x".repeat(30)}`);
		}
		const bigContent = plainLines.join("\n");

		// Fire tool_result to register it
		for (const h of handlers.get("tool_result") || []) {
			h({
				type: "tool_result", toolCallId: "tc-kl1", toolName: "read",
				input: { path: "/src/big.py" }, content: [{ type: "text", text: bigContent }], isError: false,
			}, {});
		}

		// Model emits summarize with keepLines
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-kl1","action":"summarize","summary":"200-line Python file with utils.","keepLines":[[1,3],[100,102]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}

		assert.equal(appended.length, 1);
		const persisted = appended[0].data as any;
		assert.deepEqual(persisted.keepLines, [[1, 3], [100, 102]]);
		assert.equal(persisted.cachedReplacement, undefined, "cachedReplacement must not be persisted");

		// Apply via context hook — content has line numbers like real tool results
		const contextMsgs = [
			{ role: "toolResult", toolCallId: "tc-kl1", content: [{ type: "text", text: bigContent }] },
			{ role: "assistant", content: [{ type: "text", text: "latest" }] },
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.ok(ctxResult);
		const replaced = ctxResult.messages[0].content[0].text;
		assert.ok(replaced.includes("200-line Python file with utils."), "summary present");
		assert.ok(replaced.includes("--- kept lines 1-3 ---"), "kept lines 1-3 section present");
		assert.ok(replaced.includes("--- kept lines 100-102 ---"), "kept lines 100-102 section present");
		assert.ok(replaced.includes("line 1 content"), "line 1 preserved");
		assert.ok(replaced.includes("line 3 content"), "line 3 preserved");
		assert.ok(replaced.includes("line 100 content"), "line 100 preserved");
		assert.ok(replaced.includes("line 102 content"), "line 102 preserved");
		assert.ok(!replaced.includes("line 50 content"), "line 50 not preserved");
		assert.ok(!replaced.includes("1\tline"), "N\\t line number prefixes stripped from kept lines");
	});

	it("strips N\\t prefixes from kept lines when content is numbered", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry() {},
		};
		piSift(fakePi as any);
		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		const plainLines: string[] = [];
		for (let i = 1; i <= 50; i++) plainLines.push(`content of line ${i}${"x".repeat(30)}`);
		const bigContent = plainLines.join("\n");
		for (const h of handlers.get("tool_result") || []) {
			h({ type: "tool_result", toolCallId: "tc-numbered", toolName: "read",
				input: { path: "/src/num.py" }, content: [{ type: "text", text: bigContent }], isError: false }, {});
		}

		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-numbered","action":"summarize","summary":"Numbered file.","keepLines":[[2,3]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) h({ message: assistantMsg }, {});

		// Simulate real content: N\t numbered lines (no marker prefix)
		const numbered = bigContent.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n");
		const contextMsgs = [
			{ role: "toolResult", toolCallId: "tc-numbered", content: [{ type: "text", text: numbered }] },
			{ role: "assistant", content: [{ type: "text", text: "latest" }] },
		];
		for (const h of handlers.get("context") || []) h({ messages: contextMsgs }, {});
		const replaced = contextMsgs[0].content[0].text;
		assert.ok(replaced.includes("content of line 2"), "line 2 content present");
		assert.ok(replaced.includes("content of line 3"), "line 3 content present");
		assert.ok(!replaced.includes("2\tcontent"), "N\\t prefix stripped from kept line 2");
		assert.ok(!replaced.includes("3\tcontent"), "N\\t prefix stripped from kept line 3");
	});

	it("offset read numbers lines from file offset and keepLines uses file line numbers", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry() {},
		};
		piSift(fakePi as any);
		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// Simulate a file with 50 lines, read starting at offset 200 (must exceed minCharsToScore=5000)
		const plainLines: string[] = [];
		for (let i = 0; i < 50; i++) plainLines.push(`file line ${200 + i} content${"x".repeat(100)}`);
		const bigContent = plainLines.join("\n");

		// tool_result with offset=200
		let numberedResult: string | undefined;
		for (const h of handlers.get("tool_result") || []) {
			const result = h({ type: "tool_result", toolCallId: "tc-offset", toolName: "read",
				input: { path: "/src/big.py", offset: 200 },
				content: [{ type: "text", text: bigContent }], isError: false }, {}) as any;
			if (result?.content?.[0]?.text) numberedResult = result.content[0].text;
		}

		// Verify lines are numbered starting from 200
		assert.ok(numberedResult, "tool_result returned numbered content");
		assert.ok(numberedResult!.startsWith("200\t"), "first line numbered from offset");
		assert.ok(numberedResult!.includes("249\t"), "last line uses file line number");

		// Model scores with file line numbers: keep lines 202-204
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-offset","action":"summarize","summary":"Offset read summary.","keepLines":[[202,204]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) h({ message: assistantMsg }, {});

		// Context pass — provide the numbered content as stored
		const contextMsgs = [
			{ role: "toolResult", toolCallId: "tc-offset", content: [{ type: "text", text: numberedResult }] },
			{ role: "assistant", content: [{ type: "text", text: "latest" }] },
		];
		for (const h of handlers.get("context") || []) h({ messages: contextMsgs }, {});
		const replaced = contextMsgs[0].content[0].text;

		// Header should show file line numbers
		assert.ok(replaced.includes("--- kept lines 202-204 ---"), "header shows file line numbers");
		// Content should be file lines 202, 203, 204 (0-indexed: lines at index 2, 3, 4 of the result)
		assert.ok(replaced.includes("file line 202 content"), "kept line 202 present");
		assert.ok(replaced.includes("file line 203 content"), "kept line 203 present");
		assert.ok(replaced.includes("file line 204 content"), "kept line 204 present");
		// Should NOT contain adjacent lines
		assert.ok(!replaced.includes("file line 201 content"), "line 201 not present");
		assert.ok(!replaced.includes("file line 205 content"), "line 205 not present");
	});

	it("cachedReplacement is reused on second context pass", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		const plainLines: string[] = [];
		for (let i = 1; i <= 200; i++) {
			plainLines.push(`line ${i} of file${"x".repeat(30)}`);
		}
		const bigContent = plainLines.join("\n");

		for (const h of handlers.get("tool_result") || []) {
			h({
				type: "tool_result", toolCallId: "tc-cache1", toolName: "read",
				input: { path: "/src/cached.py" }, content: [{ type: "text", text: bigContent }], isError: false,
			}, {});
		}

		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-cache1","action":"summarize","summary":"Cached file.","keepLines":[[5,5]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}

		// First context pass - builds cachedReplacement (no marker, just content)
		const msgs1 = [
			{ role: "toolResult", toolCallId: "tc-cache1", content: [{ type: "text", text: bigContent }] },
			{ role: "assistant", content: [{ type: "text", text: "latest" }] },
		];
		for (const h of handlers.get("context") || []) {
			h({ messages: msgs1 }, {});
		}
		const firstResult = msgs1[0].content[0].text;

		// Second context pass - should use cachedReplacement
		const msgs2 = [
			{ role: "toolResult", toolCallId: "tc-cache1", content: [{ type: "text", text: bigContent }] },
			{ role: "assistant", content: [{ type: "text", text: "latest" }] },
		];
		for (const h of handlers.get("context") || []) {
			h({ messages: msgs2 }, {});
		}
		const secondResult = msgs2[0].content[0].text;

		assert.equal(firstResult, secondResult, "cachedReplacement should produce identical output");
	});
});

describe("buildScoringInstruction mentions keepLines", () => {
	it("scoring prompt mentions keepLines", () => {
		const instruction = buildScoringInstruction([
			{ toolCallId: "tc-1", toolName: "read", size: 5000, path: "/test.py", assistantMessagesSinceMarked: 0, instructionInjected: false },
		]);
		assert.ok(instruction.includes("keepLines"), "scoring prompt should mention keepLines");
		assert.ok(instruction.includes("[start,end]"), "scoring prompt should describe keepLines format");
	});
});

// Helper to set up a fresh piSift instance with fakePi
const setupPiSift = async () => {
	const { default: piSift } = await import("./index.js");
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const fakePi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerCommand() {},
		appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
	};
	piSift(fakePi as any);
	// session_start to initialize
	for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });
	return { handlers, appended };
};

const fireToolResult = (handlers: Map<string, Array<(...args: unknown[]) => unknown>>, opts: { toolCallId: string; toolName: string; path: string; size: number }) => {
	let result: any;
	for (const h of handlers.get("tool_result") || []) {
		result = h({
			type: "tool_result",
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			input: { path: opts.path },
			content: [{ type: "text", text: "x".repeat(opts.size) }],
			isError: false,
		}, {});
	}
	return result;
};

const fireToolResultWithOffset = (handlers: Map<string, Array<(...args: unknown[]) => unknown>>, opts: { toolCallId: string; toolName: string; path: string; size: number; offset: number }) => {
	let result: any;
	for (const h of handlers.get("tool_result") || []) {
		result = h({
			type: "tool_result",
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			input: { path: opts.path, offset: opts.offset },
			content: [{ type: "text", text: "x".repeat(opts.size) }],
			isError: false,
		}, {});
	}
	return result;
};

const fireToolExecutionStart = (handlers: Map<string, Array<(...args: unknown[]) => unknown>>, opts: { toolName: string; path: string }) => {
	for (const h of handlers.get("tool_execution_start") || []) {
		h({ toolName: opts.toolName, args: { path: opts.path } }, {});
	}
};

describe("Heuristic context pruning", () => {
	it("re-read dismisses previous read", async () => {
		const { handlers, appended } = await setupPiSift();

		// First read of file A
		fireToolResult(handlers, { toolCallId: "tc-read1", toolName: "read", path: "/src/big.py", size: 5000 });
		assert.equal(appended.length, 0, "no heuristic dismiss yet");

		// Re-read of file A
		const result = fireToolResult(handlers, { toolCallId: "tc-read2", toolName: "read", path: "/src/big.py", size: 5000 });

		// Old read should be dismissed
		assert.equal(appended.length, 1, "heuristic dismiss should fire");
		const decision = appended[0].data as any;
		assert.equal(decision.toolCallId, "tc-read1");
		assert.equal(decision.action, "dismiss");
		assert.ok(decision.summary.includes("superseded by re-read"));

		// New read should still be marked for scoring (returns line-numbered content)
		assert.ok(result, "new read should be marked for scoring");
		assert.ok(result.content[0].text.startsWith("1\t"));
	});

	it("targeted re-read dismisses full read", async () => {
		const { handlers, appended } = await setupPiSift();

		// Full read
		fireToolResult(handlers, { toolCallId: "tc-full", toolName: "read", path: "/src/large.py", size: 10000 });

		// Targeted re-read (same path, with offset — simulates partial read)
		fireToolResultWithOffset(handlers, { toolCallId: "tc-targeted", toolName: "read", path: "/src/large.py", size: 3000, offset: 100 });

		// Full read should be dismissed
		assert.equal(appended.length, 1);
		const decision = appended[0].data as any;
		assert.equal(decision.toolCallId, "tc-full");
		assert.equal(decision.action, "dismiss");
		assert.ok(decision.summary.includes("superseded by re-read"));
	});

	it("offset reads of same file do not dismiss each other", async () => {
		const { handlers, appended } = await setupPiSift();

		// Two offset reads of the same file — different sections
		fireToolResultWithOffset(handlers, { toolCallId: "tc-section1", toolName: "read", path: "/src/big.py", size: 3000, offset: 100 });
		fireToolResultWithOffset(handlers, { toolCallId: "tc-section2", toolName: "read", path: "/src/big.py", size: 3000, offset: 500 });

		// Neither should be dismissed — they may be complementary
		assert.equal(appended.length, 0, "offset reads should not dismiss each other");
	});

	it("re-read preserves summarize+keepLines decision", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file
		fireToolResult(handlers, { toolCallId: "tc-kept", toolName: "read", path: "/src/kept.py", size: 8000 });

		// Model summarizes with keepLines
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-kept","action":"summarize","summary":"Module with utils.","keepLines":[[10,20]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		assert.equal(appended.length, 1);
		assert.equal((appended[0].data as any).action, "summarize");

		// Re-read same file (e.g. model wants a different section)
		fireToolResult(handlers, { toolCallId: "tc-reread-kept", toolName: "read", path: "/src/kept.py", size: 5000 });

		// Should NOT dismiss the keepLines decision
		const dismisses = appended.filter((a) => (a.data as any).toolCallId === "tc-kept" && (a.data as any).action === "dismiss");
		assert.equal(dismisses.length, 0, "summarize+keepLines should not be dismissed by re-read");
	});

	it("re-read still dismisses plain summarize without keepLines", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file
		fireToolResult(handlers, { toolCallId: "tc-plain", toolName: "read", path: "/src/plain.py", size: 8000 });

		// Model summarizes without keepLines
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-plain","action":"summarize","summary":"Module with utils."}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		assert.equal(appended.length, 1);

		// Re-read same file
		fireToolResult(handlers, { toolCallId: "tc-reread-plain", toolName: "read", path: "/src/plain.py", size: 5000 });

		// SHOULD dismiss — no keepLines to preserve
		const dismisses = appended.filter((a) => (a.data as any).toolCallId === "tc-plain" && (a.data as any).action === "dismiss");
		assert.equal(dismisses.length, 1, "plain summarize should still be dismissed by re-read");
	});

	it("edit dismisses previous read", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file A
		fireToolResult(handlers, { toolCallId: "tc-readA", toolName: "read", path: "/src/component.py", size: 8000 });

		// Edit file A
		fireToolExecutionStart(handlers, { toolName: "edit", path: "/src/component.py" });

		// Read should be dismissed as stale
		assert.equal(appended.length, 1);
		const decision = appended[0].data as any;
		assert.equal(decision.toolCallId, "tc-readA");
		assert.equal(decision.action, "dismiss");
		assert.ok(decision.summary.includes("stale after edit"));
	});

	it("edit preserves summarize+keepLines decision", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file
		fireToolResult(handlers, { toolCallId: "tc-edit-kept", toolName: "read", path: "/src/edit-kept.py", size: 8000 });

		// Model summarizes with keepLines
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-edit-kept","action":"summarize","summary":"Module.","keepLines":[[10,20]]}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		assert.equal(appended.length, 1);

		// Edit the same file
		fireToolExecutionStart(handlers, { toolName: "edit", path: "/src/edit-kept.py" });

		// Should NOT dismiss — keepLines are still useful context
		const dismisses = appended.filter((a) => (a.data as any).toolCallId === "tc-edit-kept" && (a.data as any).action === "dismiss");
		assert.equal(dismisses.length, 0, "summarize+keepLines should not be dismissed by edit");
	});

	it("fresh read after edit is scored normally", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read → edit (dismisses read) → read again
		fireToolResult(handlers, { toolCallId: "tc-r1", toolName: "read", path: "/src/file.py", size: 5000 });
		fireToolExecutionStart(handlers, { toolName: "edit", path: "/src/file.py" });
		assert.equal(appended.length, 1, "first read dismissed by edit");

		// Advance past the edited-file protection window (default 4 turns)
		for (const h of handlers.get("turn_start") || []) h({ turnIndex: 10 });

		// Fresh read after edit should be scored (returns line-numbered content)
		const result = fireToolResult(handlers, { toolCallId: "tc-r2", toolName: "read", path: "/src/file.py", size: 5000 });
		assert.ok(result, "fresh read should be marked for scoring");
		assert.ok(result.content[0].text.startsWith("1\t"));
		// No additional heuristic dismiss (only the one from the edit)
		assert.equal(appended.length, 1, "no extra heuristic dismiss for fresh read");
	});

	it("scoring prompt contains bias text", () => {
		const instruction = buildScoringInstruction([
			{ toolCallId: "tc-1", toolName: "read", size: 5000, path: "/test.py", assistantMessagesSinceMarked: 0, instructionInjected: false },
		]);
		assert.ok(instruction.includes("Prefer summarize over keep"), "scoring prompt should contain bias text");
	});

	it("heuristic dismiss overrides existing keep decision", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file A
		fireToolResult(handlers, { toolCallId: "tc-decided", toolName: "read", path: "/src/decided.py", size: 5000 });

		// Simulate model deciding to keep it via message_end
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: '<context_lens>{"toolCallId":"tc-decided","action":"keep"}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		assert.equal(appended.length, 1, "model decision persisted");
		assert.equal((appended[0].data as any).action, "keep");

		// Re-read the same file — heuristic SHOULD override the keep with dismiss
		fireToolResult(handlers, { toolCallId: "tc-reread", toolName: "read", path: "/src/decided.py", size: 5000 });

		const dismissDecisions = appended.filter((a) => (a.data as any).toolCallId === "tc-decided" && (a.data as any).action === "dismiss");
		assert.equal(dismissDecisions.length, 1, "heuristic should override keep with dismiss");
	});

	it("heuristic dismiss skips already-dismissed toolCallId", async () => {
		const { handlers, appended } = await setupPiSift();

		// Read file A twice — first read gets heuristic-dismissed
		fireToolResult(handlers, { toolCallId: "tc-first", toolName: "read", path: "/src/file.py", size: 5000 });
		fireToolResult(handlers, { toolCallId: "tc-second", toolName: "read", path: "/src/file.py", size: 5000 });
		assert.equal(appended.length, 1, "first read dismissed");
		assert.equal((appended[0].data as any).action, "dismiss");

		// Third read — tc-second should be dismissed, but tc-first should NOT get a second dismiss
		fireToolResult(handlers, { toolCallId: "tc-third", toolName: "read", path: "/src/file.py", size: 5000 });
		assert.equal(appended.length, 2, "only tc-second dismissed, tc-first not re-dismissed");
		assert.equal((appended[1].data as any).toolCallId, "tc-second");
	});
});
