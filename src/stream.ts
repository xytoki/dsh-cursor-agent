import { ToolCallId } from "@deepseek-ai/dsh-llm";

/**
 * One assistant stream's content-block indexes. DSH assembles by index and
 * keeps one text/reasoning lane per index, so a tool batch must retire BOTH
 * lanes. Clearing only a shared `afterWork` flag is not enough: the next
 * thinking-delta consumes the flag and later process/answer text reuses the
 * old text index (session 28f42898 glued every narration into index 1).
 */
export function createStreamBlocks() {
	let next = 0;
	let textIndex;
	let reasoningIndex;
	const take = () => next++;
	const retireLanes = () => {
		textIndex = undefined;
		reasoningIndex = undefined;
	};
	const open = (kind, current) => {
		const fresh = current === undefined;
		const index = fresh ? take() : current;
		return {
			index,
			chunks: fresh
				? [{ type: "block-start", index, blockType: kind }]
				: [],
		};
	};
	return {
		markWork() {
			retireLanes();
		},
		reasoning(text) {
			const opened = open("reasoning", reasoningIndex);
			reasoningIndex = opened.index;
			return [...opened.chunks, { type: "reasoning-delta", index: opened.index, text }];
		},
		text(text) {
			const opened = open("text", textIndex);
			textIndex = opened.index;
			return [...opened.chunks, { type: "text-delta", index: opened.index, text }];
		},
		toolCall() {
			retireLanes();
			return take();
		},
	};
}

/** One official stream tool-call block (start + delta + end) at a fresh index. */
export function emitToolCall(streamBlocks, { id, name, args }) {
	const index = streamBlocks.toolCall();
	const argumentsText = JSON.stringify(args ?? {});
	return [
		{ type: "block-start", index, blockType: "tool-call" },
		{ type: "tool-call-delta", index, id: ToolCallId(id), name, argumentsDelta: argumentsText },
		{
			type: "block-end",
			index,
			block: { type: "tool-call", id: ToolCallId(id), name, arguments: argumentsText },
		},
	];
}
