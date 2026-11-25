import * as vscode from "vscode";
import { PreviewSession } from "./preview";
import { resolveTrustedDirs, trustConfig } from "./trust";

let session: PreviewSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("MdLive");
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.commands.registerCommand("mdlive.openPreview", async (uri?: vscode.Uri) => {
      const document = uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;

      if (!document || document.languageId !== "markdown") {
        void vscode.window.showWarningMessage("MdLive: open a Markdown file first.");
        return;
      }

      if (session) {
        session.track(document);
        session.reveal();
        return;
      }

      try {
        session = await PreviewSession.open(document, log, () => (session = undefined));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? " Install it with `dotnet tool install -g ScuroGuardiano.MdLive` or set mdlive.path."
          : "";
        const choice = await vscode.window.showErrorMessage(`MdLive: can't start mdlive: ${message}.${hint}`, "Show Log");
        if (choice) {
          log.show();
        }
      }
    }),

    vscode.commands.registerCommand("mdlive.stop", () => session?.dispose()),

    vscode.commands.registerCommand("mdlive.showLog", () => log.show()),

    vscode.commands.registerCommand("mdlive.trust", async () => {
      const config = vscode.workspace.getConfiguration("mdlive");
      const document = vscode.window.activeTextEditor?.document;
      const cwd = session?.workingDirectory
        ?? (document ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath : undefined)
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!cwd) {
        void vscode.window.showWarningMessage("MdLive: open a folder or a Markdown file first.");
        return;
      }

      const { dirs } = resolveTrustedDirs(config.get<string[]>("trustedDirs", []));
      if (await trustConfig(config.get<string>("path", "mdlive"), cwd, dirs)) {
        session?.rerender();
      }
    }),

    { dispose: () => session?.dispose() },
  );
}

export function deactivate(): void {
  session?.dispose();
}
