/**
 * Base interface every sub-agent implements.
 *
 * The Dispatcher only ever sees SubAgent — it doesn't know whether
 * the underlying implementation drives Playwright, edits files, or
 * just runs a single LLM call. That separation is what lets us add a
 * Code Agent or a Research Agent later without touching the
 * orchestration core.
 */

import type { StepKind } from "../core/types.js";

export interface SubAgentResult {
  /** Free-form text describing what the agent accomplished. Goes
   *  into the run summary AND can be fed as context to the next
   *  step's sub-agent if the planner chains them. */
  result: string;
  /** Number of LLM rounds the sub-agent used. Useful for cost
   *  tracking and runaway-loop detection. */
  rounds: number;
}

/**
 * Progress callback. Sub-agents call this between iterations of
 * their inner loop so the CLI can stream "navigating to…", "clicked
 * search button", etc. live to the user.
 */
export type ProgressCallback = (message: string) => void;

/**
 * Screenshot callback. Sub-agents call this after any tool call that
 * visibly changes the page (browser: navigate/click/type/scroll/etc.)
 * so the UI can render the agent's viewport inline — that's the
 * "embedded browser" feel from Manus.
 *
 * `dataUrl` is a base64 JPEG (data:image/jpeg;base64,…). Sub-agents
 * that don't have a viewport (code, answer) just never call this.
 */
export type ScreenshotCallback = (dataUrl: string) => void;

export interface SubAgent {
  /** Discriminator the dispatcher uses to route Steps. */
  readonly kind: StepKind;

  /**
   * Execute one Step. Returns the result; throws on failure (the
   * dispatcher catches and maps to step_failed).
   *
   * `previousResults` carries the results of every prior step in the
   * same run, in order. Useful when a step says "click the result
   * you found in step 2" — the sub-agent has access to step 2's
   * extracted text without re-doing the work.
   */
  run(input: {
    description: string;
    previousResults: string[];
    onProgress: ProgressCallback;
    onScreenshot?: ScreenshotCallback;
  }): Promise<SubAgentResult>;

  /** Cleanup hook called at end of run (success OR failure). Used
   *  by the browser agent to close the headless Chromium. */
  shutdown?(): Promise<void>;
}
