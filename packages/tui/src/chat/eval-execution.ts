/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import type { Loader } from "../components/loader";
import { Text } from "../components/text";
import { Container, type TUI } from "../tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getThemeEpoch, highlightCode, theme } from "../theme/theme";
import type { OutputArtifactError } from "../tools/streaming-output";
import type { TruncationMeta } from "../tools/output-meta";
import { OutputPane } from "../render/output-pane";
import {
	buildExecutionFrame,
	buildStatusFooter,
	clampDisplayLine,
	describeExecutionCard,
	describeExecutionTool,
	type ExecutionColorKey,
	type ExecutionStatus,
	PREVIEW_LINES,
	resolveExecutionStatus,
} from "./execution-shared";
import { code, span } from "../native/describe";
import { type DescribeContext, type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";

export type EvalExecutionLanguage = "python" | "js";

// Coalesced chunks past this size flush into the pane immediately, bounding
// the backlog when renders stall.
const MAX_PENDING_OUTPUT_CHARS = 1 << 20;

export class EvalExecutionComponent extends Container {
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#artifactError?: OutputArtifactError;
	#expanded = false;
	// Post-finalize mutation counter (FinalizableBlock.getTranscriptBlockVersion):
	// a completed cell's block still mutates on expansion toggles, and the
	// transcript's width-epoch resolution and committed-render bypass must
	// observe that.
	#blockVersion = 0;
	#contentContainer: Container;
	#outputPane: OutputPane;
	// Highlighted cell source; rebuilt only when the theme epoch moves.
	#headerText: Text;
	#headerThemeEpoch: number;
	// Streamed chunks coalesce here and enter the pane once per render.
	#pendingOutput: string[] = [];
	#pendingOutputChars = 0;
	#displayDirty = false;
	readonly #code: string;
	readonly #excludeFromContext: boolean;
	readonly #language: EvalExecutionLanguage;
	readonly #startedAt = performance.now();
	#endedAt: number | undefined;
	// Bumped whenever the output pane's text changes.
	#outputVersion = 0;
	readonly #native = new Memo();

	#highlightLang(): "python" | "javascript" {
		return this.#language === "js" ? "javascript" : "python";
	}

	#formatHeader(): Text {
		const colorKey: ExecutionColorKey = this.#excludeFromContext ? "dim" : "pythonMode";
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.#code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 1, 0);
	}

	constructor(code: string, ui: TUI, excludeFromContext = false, language: EvalExecutionLanguage = "python") {
		super();
		this.#code = code;
		this.#excludeFromContext = excludeFromContext;
		this.#language = language;

		const colorKey: ExecutionColorKey = this.#excludeFromContext ? "dim" : "pythonMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;
		this.#outputPane = new OutputPane(theme, {
			expanded: false,
			collapsedMaxLines: PREVIEW_LINES,
			edge: "tail",
			visual: true,
			paddingX: 1,
			leadingBlank: true,
			showHiddenMarker: false,
			showExpandHint: false,
			styleLine: line => theme.fg("muted", line),
			normalizeLine: clampDisplayLine,
		});

		this.#headerText = this.#formatHeader();
		this.#headerThemeEpoch = getThemeEpoch();
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): the collapsed
	 * streaming preview rewrites its tail window every chunk, so the block must
	 * stay out of native scrollback until the cell completes.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#status !== "running";
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#outputPane.setExpanded(expanded);
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		const themeEpoch = getThemeEpoch();
		if (themeEpoch !== this.#headerThemeEpoch) {
			this.#headerThemeEpoch = themeEpoch;
			this.#headerText = this.#formatHeader();
		}
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	/**
	 * The agent's eval `tool` frame (role `omp.eval`) with a `you` badge: the
	 * cell source in the head, its output as an `ansi` mini terminal. Terminals
	 * without the `tool` kind get a `card` with the cell as `code` over the output.
	 */
	override describe(cx?: DescribeContext): NativeNode {
		this.#flushPendingOutput();
		const dataFirst = cx?.supports("tool") === true;
		const key = [dataFirst, this.#outputVersion, this.#status, this.#expanded];
		return this.#native.get(key, () => {
			const title = this.#language === "js" ? "JavaScript" : "Python";
			const common = {
				role: "omp.eval",
				status: this.#status,
				startedAt: this.#startedAt,
				expanded: this.#expanded,
				output: this.#outputPane.getText(),
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				artifactError: this.#artifactError,
			};
			return dataFirst
				? describeExecutionTool({
						...common,
						name: "eval",
						title,
						command: this.#code,
						lang: this.#highlightLang(),
						excluded: this.#excludeFromContext,
						endedAt: this.#endedAt,
					})
				: describeExecutionCard({
						...common,
						head: [span(title, `${this.#excludeFromContext ? "dim" : "pythonMode"} strong`)],
						muted: this.#excludeFromContext,
						lead: [code(this.#code, { lang: this.#highlightLang(), key: "code" })],
					});
		});
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		// Per-chunk work stays O(1): the pane ingests the batch in render().
		if (!chunk) return;
		this.#pendingOutput.push(chunk);
		this.#pendingOutputChars += chunk.length;
		if (this.#pendingOutputChars > MAX_PENDING_OUTPUT_CHARS) this.#flushPendingOutput();
		this.#outputVersion++;
		this.#displayDirty = true;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta; artifactError?: OutputArtifactError },
	): void {
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#endedAt ??= performance.now();
		this.#truncation = options?.truncation;
		this.#artifactError = options?.artifactError;
		this.#flushPendingOutput();
		this.#outputPane.finish();
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}
		this.#outputVersion++;

		this.#loader.stop();
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	override render(width: number): readonly string[] {
		if (this.#displayDirty) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#flushPendingOutput(): void {
		if (this.#pendingOutput.length === 0) return;
		const batch = this.#pendingOutput.join("");
		this.#pendingOutput = [];
		this.#pendingOutputChars = 0;
		this.#outputPane.append(batch);
	}

	#updateDisplay(): void {
		this.#flushPendingOutput();
		// Only the collapsed preview hides lines; when expanded the footer must
		// not keep advertising hidden lines / ctrl+o.
		const hiddenLineCount = this.#expanded ? 0 : Math.max(0, this.#outputPane.lineCount - PREVIEW_LINES);

		this.#contentContainer.clear();

		this.#contentContainer.addChild(this.#headerText);

		if (this.#outputPane.lineCount > 0) this.#contentContainer.addChild(this.#outputPane);

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				artifactError: this.#artifactError,
				hiddenLineCount,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputPane.setText(clean);
	}

	getOutput(): string {
		this.#flushPendingOutput();
		return this.#outputPane.getText();
	}

	getCode(): string {
		return this.#code;
	}
}
