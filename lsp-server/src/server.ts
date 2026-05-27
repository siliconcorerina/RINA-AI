#!/usr/bin/env node
/**
 * RINA AI Language Server — main entry point.
 *
 * Speaks LSP over stdio so it works with every LSP-aware editor: Neovim
 * (via nvim-lspconfig), Helix, Zed, Sublime Text (LSP package), Emacs
 * (lsp-mode / eglot), JupyterLab (jupyterlab-lsp), and of course any
 * other VS Code-derived editor.
 *
 * Capabilities exposed:
 *   - code actions  → "RINA AI: Explain / Refactor / Generate tests"
 *   - commands      → rina.explain, rina.refactor, rina.generateTests
 *   - completion    → on-demand fill-in-the-middle (opt-in via config)
 *
 * Configuration comes via `initializationOptions` sent by the LSP
 * client. Example client config:
 *
 *     {
 *       "backend": "openai:gpt-4o-mini",
 *       "language": "fr",
 *       "completion": { "enabled": true, "trigger": "manual" },
 *       "maxTokens": 1024,
 *       "temperature": 0.2
 *     }
 *
 * API keys come from env (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * MISTRAL_API_KEY, RINA_API_KEY) — never from initializationOptions,
 * so they don't end up in editor config files.
 */

import {
  ApplyWorkspaceEditRequest,
  CodeAction,
  CodeActionKind,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Hover,
  InitializeParams,
  InitializeResult,
  MessageType,
  Position,
  ProposedFeatures,
  Range,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

import { Backend, backendFromSpec, GenerationConfig } from "./backend.js";
import { DEFAULT_CONFIG, mergeConfig, RinaConfig } from "./config.js";
import {
  buildCompletionPrompt,
  buildExplainPrompt,
  buildGenerateTestsPrompt,
  buildRefactorPrompt,
  extractCode,
} from "./prompts.js";

const COMMAND = {
  explain: "rina.explain",
  refactor: "rina.refactor",
  generateTests: "rina.generateTests",
  completion: "rina.completion",
} as const;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);

let config: RinaConfig = { ...DEFAULT_CONFIG };
let backend: Backend | null = null;

// ─────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────

connection.onInitialize((params: InitializeParams): InitializeResult => {
  config = mergeConfig(DEFAULT_CONFIG, params.initializationOptions);
  try {
    backend = backendFromSpec(config.backend);
    connection.console.info(`[RINA] Backend ready: ${backend.spec}`);
  } catch (err) {
    // We don't fail the handshake — the editor can still load the
    // server, and the user just sees an error message when they
    // actually try an action. Failing init would hide the diagnostic.
    backend = null;
    connection.console.error(`[RINA] Backend init failed: ${(err as Error).message}`);
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.Refactor, CodeActionKind.QuickFix],
        resolveProvider: false,
      },
      executeCommandProvider: { commands: Object.values(COMMAND) },
      completionProvider: config.completion.enabled
        ? { triggerCharacters: config.completion.trigger === "auto" ? ["."] : [], resolveProvider: false }
        : undefined,
      hoverProvider: false,
    },
    serverInfo: { name: "rina-lsp-server", version: "0.1.0" },
  };
});

// ─────────────────────────────────────────────────────────────────────
// Code actions — surfaces "RINA AI: Explain / Refactor / Generate tests"
//                in the editor's code-action menu when there's a non-empty
//                selection.
// ─────────────────────────────────────────────────────────────────────

connection.onCodeAction((params): CodeAction[] => {
  if (rangesEqual(params.range.start, params.range.end)) {
    // No selection → no code-level actions to offer.
    return [];
  }
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  // We pass the URI + range as command arguments so executeCommand can
  // re-fetch the current text. Re-fetching matters: the document may
  // have changed between the code-action request and the command
  // execution (autosave, formatter run, etc.).
  const args = [params.textDocument.uri, params.range];

  return [
    {
      title: "RINA AI: Explain",
      kind: CodeActionKind.QuickFix,
      command: { title: "Explain", command: COMMAND.explain, arguments: args },
    },
    {
      title: "RINA AI: Refactor",
      kind: CodeActionKind.Refactor,
      command: { title: "Refactor", command: COMMAND.refactor, arguments: args },
    },
    {
      title: "RINA AI: Generate tests",
      kind: CodeActionKind.Refactor,
      command: { title: "Generate tests", command: COMMAND.generateTests, arguments: args },
    },
  ];
});

// ─────────────────────────────────────────────────────────────────────
// Command execution — the actual model calls.
// ─────────────────────────────────────────────────────────────────────

connection.onExecuteCommand(async (params) => {
  if (!backend) {
    notify(MessageType.Error, "RINA AI backend not configured. Check your API key env var.");
    return;
  }

  const [uri, range] = (params.arguments ?? []) as [string, Range | undefined];
  const document = documents.get(uri);
  if (!document) {
    notify(MessageType.Warning, "RINA AI: no document for that URI.");
    return;
  }

  const selection = range ? document.getText(range) : "";
  const language = document.languageId;
  const genCfg: GenerationConfig = { maxTokens: config.maxTokens, temperature: config.temperature };

  switch (params.command) {
    case COMMAND.explain:
      await handleExplain(selection, language, genCfg);
      break;
    case COMMAND.refactor:
      await handleRefactor(uri, range, selection, language, genCfg);
      break;
    case COMMAND.generateTests:
      await handleGenerateTests(selection, language, genCfg);
      break;
    case COMMAND.completion:
      // Triggered manually by the client; the actual completion list
      // is returned via onCompletion below, not via this command. We
      // keep the entry for symmetry / discoverability.
      break;
    default:
      notify(MessageType.Warning, `RINA AI: unknown command ${params.command}`);
  }
});

async function handleExplain(
  selection: string,
  language: string,
  genCfg: GenerationConfig
): Promise<void> {
  if (!selection.trim()) {
    notify(MessageType.Info, "RINA AI: select some code first.");
    return;
  }
  try {
    const messages = buildExplainPrompt({ code: selection, language }, config.language);
    const reply = await backend!.generate(messages, genCfg);
    // No UI buffer abstraction in LSP — surface the explanation as a
    // ShowMessage. Editors that want pretty rendering can override
    // window.showMessage with a markdown panel.
    connection.window.showInformationMessage(reply);
  } catch (err) {
    notify(MessageType.Error, `RINA AI: ${(err as Error).message}`);
  }
}

async function handleRefactor(
  uri: string,
  range: Range | undefined,
  selection: string,
  language: string,
  genCfg: GenerationConfig
): Promise<void> {
  if (!selection.trim() || !range) {
    notify(MessageType.Info, "RINA AI: select some code first.");
    return;
  }
  try {
    const messages = buildRefactorPrompt({ code: selection, language }, config.language);
    const reply = await backend!.generate(messages, genCfg);
    const refactored = extractCode(reply);

    const edit: WorkspaceEdit = {
      changes: { [uri]: [TextEdit.replace(range, refactored)] },
    };
    await connection.sendRequest(ApplyWorkspaceEditRequest.type, {
      label: "RINA AI: Refactor",
      edit,
    });
  } catch (err) {
    notify(MessageType.Error, `RINA AI: ${(err as Error).message}`);
  }
}

async function handleGenerateTests(
  selection: string,
  language: string,
  genCfg: GenerationConfig
): Promise<void> {
  if (!selection.trim()) {
    notify(MessageType.Info, "RINA AI: select some code first.");
    return;
  }
  try {
    const messages = buildGenerateTestsPrompt({ code: selection, language }, config.language);
    const reply = await backend!.generate(messages, genCfg);
    // We surface tests as a message rather than a WorkspaceEdit — picking
    // the right destination file (test_x.py? x.spec.ts?) is a separate
    // UX problem and varies wildly by project layout. Better to give
    // the user the code and let them place it.
    connection.window.showInformationMessage(reply);
  } catch (err) {
    notify(MessageType.Error, `RINA AI: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Completion — fill-in-the-middle at the cursor. Triggered either by
// the client's standard completion request (Ctrl+Space etc.) when
// completion.enabled === true, or by the user binding a keymap to
// `rina.completion`.
//
// We deliberately don't return completions on every keystroke — the
// model is too expensive and slow for that. If the user wants
// auto-trigger, they set `completion.trigger: "auto"` and we accept
// "." as a trigger character (cheap heuristic for "user just typed
// something and waited"). Even then, only one completion item is
// returned so the editor doesn't try to filter against a list.
// ─────────────────────────────────────────────────────────────────────

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  if (!config.completion.enabled || !backend) {
    return [];
  }
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  // Send a generous but bounded prefix/suffix window. Models perform
  // worse with the whole file dumped in front of them.
  const PREFIX_WINDOW = 2000;
  const SUFFIX_WINDOW = 500;
  const cursor = document.offsetAt(params.position);
  const full = document.getText();
  const prefix = full.slice(Math.max(0, cursor - PREFIX_WINDOW), cursor);
  const suffix = full.slice(cursor, Math.min(full.length, cursor + SUFFIX_WINDOW));

  try {
    const messages = buildCompletionPrompt(
      { prefix, suffix, language: document.languageId },
      config.language
    );
    // Completion benefits from a tighter token cap — most useful
    // completions are <200 tokens. Long completions tend to wander.
    const reply = await backend.generate(messages, {
      maxTokens: Math.min(config.maxTokens, 256),
      temperature: config.temperature,
      stop: ["\n\n\n"],
    });
    const text = extractCode(reply);
    if (!text) {
      return [];
    }
    return [
      {
        label: text.split("\n")[0].slice(0, 60) || "RINA suggestion",
        kind: CompletionItemKind.Snippet,
        insertText: text,
        detail: `RINA AI (${backend.spec})`,
        documentation: { kind: "markdown", value: "Generated by RINA AI." },
      },
    ];
  } catch (err) {
    connection.console.error(`[RINA] completion failed: ${(err as Error).message}`);
    return [];
  }
});

// Hover stub (disabled in capabilities but reserved for future use —
// e.g. "explain the symbol under the cursor" on hover).
connection.onHover(async (): Promise<Hover | null> => null);

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function notify(type: MessageType, msg: string): void {
  // Editors render ShowMessage as a toast; ShowMessageRequest would
  // demand a user click. Use the lighter variant for info / warn.
  switch (type) {
    case MessageType.Error:
      connection.window.showErrorMessage(msg);
      break;
    case MessageType.Warning:
      connection.window.showWarningMessage(msg);
      break;
    default:
      connection.window.showInformationMessage(msg);
  }
}

function rangesEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

documents.listen(connection);
connection.listen();
