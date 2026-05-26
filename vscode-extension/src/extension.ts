import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { URL } from "url";

const SECRET_KEY = "rinaAI.apiKey";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("rinaAI.setApiKey", () => setApiKey(context)),
    vscode.commands.registerCommand("rinaAI.explain", () => runOnSelection(context, "explain")),
    vscode.commands.registerCommand("rinaAI.refactor", () => runOnSelection(context, "refactor")),
    vscode.commands.registerCommand("rinaAI.generate", () => runGenerate(context))
  );
}

export function deactivate() {}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "RINA AI — cle API",
    prompt: "Colle ta cle API (rina_...)",
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  await context.secrets.store(SECRET_KEY, value.trim());
  vscode.window.showInformationMessage("RINA AI : cle API enregistree.");
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  let key = await context.secrets.get(SECRET_KEY);
  if (!key) {
    const choice = await vscode.window.showWarningMessage(
      "Aucune cle API RINA AI configuree.",
      "Configurer maintenant"
    );
    if (choice === "Configurer maintenant") {
      await setApiKey(context);
      key = await context.secrets.get(SECRET_KEY);
    }
  }
  return key;
}

function buildSystemPrompt(action: "explain" | "refactor"): string {
  if (action === "explain") {
    return (
      "Tu es RINA Coder. Explique le code fourni de maniere claire et concise. " +
      "Souligne les points subtils, les bugs eventuels et les ameliorations possibles."
    );
  }
  return (
    "Tu es RINA Coder. Refactore le code fourni en preservant son comportement. " +
    "Privilegie la lisibilite, la correction des bugs evidents, et explique en une " +
    "ligne ce que tu as change. Retourne uniquement le code refactore dans un bloc."
  );
}

async function runOnSelection(
  context: vscode.ExtensionContext,
  action: "explain" | "refactor"
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("Selectionne du code d'abord.");
    return;
  }
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }
  const selection = editor.document.getText(editor.selection);
  const language = editor.document.languageId;

  const reply = await withProgress(
    `RINA AI : ${action === "explain" ? "explication" : "refactoring"}…`,
    () =>
      callApi(apiKey, {
        system: buildSystemPrompt(action),
        prompt: `Langage : ${language}\n\nCode :\n${selection}`,
      })
  );
  if (!reply) {
    return;
  }

  if (action === "refactor") {
    await editor.edit((edit) => edit.replace(editor.selection, extractCode(reply, selection)));
    vscode.window.showInformationMessage("RINA AI : code refactore.");
  } else {
    await showInOutput("RINA AI — Explication", reply);
  }
}

async function runGenerate(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    return;
  }
  const prompt = await vscode.window.showInputBox({
    title: "RINA AI — generer du code",
    prompt: "Que veux-tu generer ?",
    ignoreFocusOut: true,
  });
  if (!prompt) {
    return;
  }
  const reply = await withProgress("RINA AI : generation…", () =>
    callApi(apiKey, {
      system:
        "Tu es RINA Coder. Genere uniquement le code demande dans un bloc, sans " +
        "commentaire superflu.",
      prompt,
    })
  );
  if (!reply) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const code = extractCode(reply, "");
  if (editor) {
    await editor.edit((edit) => edit.insert(editor.selection.active, code));
  } else {
    const doc = await vscode.workspace.openTextDocument({ content: code });
    await vscode.window.showTextDocument(doc);
  }
}

function extractCode(reply: string, fallback: string): string {
  const fence = reply.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (fence) {
    return fence[1].trimEnd() + "\n";
  }
  return reply.trim() ? reply : fallback;
}

async function showInOutput(title: string, body: string): Promise<void> {
  const channel = vscode.window.createOutputChannel(title);
  channel.append(body);
  channel.show(true);
}

async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => {
      try {
        return await fn();
      } catch (err) {
        vscode.window.showErrorMessage(`RINA AI : ${(err as Error).message}`);
        return undefined;
      }
    }
  );
}

interface CallOptions {
  system: string;
  prompt: string;
}

async function callApi(apiKey: string, opts: CallOptions): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("rinaAI");
  const baseUrl = cfg.get<string>("baseUrl", "https://api.plateforme-rina.com");
  const model = cfg.get<string>("model", "rina-coder-base");
  const temperature = cfg.get<number>("temperature", 0.2);
  const maxTokens = cfg.get<number>("maxTokens", 512);

  const payload = JSON.stringify({
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
    max_tokens: maxTokens,
    temperature,
  });

  const url = new URL("/v1/chat/completions", baseUrl);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "rina-ai-vscode/0.0.1",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} : ${data.slice(0, 300)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content =
              parsed?.choices?.[0]?.message?.content ??
              parsed?.output ??
              parsed?.text ??
              "";
            resolve(String(content));
          } catch (e) {
            reject(new Error("Reponse invalide : " + (e as Error).message));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
