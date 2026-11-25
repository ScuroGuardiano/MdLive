import * as path from "node:path";
import * as vscode from "vscode";
import { MdLiveServer } from "./server";
import { resolveTrustedDirs } from "./trust";

/**
 * Throttle z wywołaniem na końcu, jak w pluginie neovima: pierwsze zdarzenie od razu, kolejne w oknie
 * zwijane do jednego po jego upływie, więc podgląd nadąża w trakcie pisania i ostatnia zmiana nie przepada.
 */
function throttled(fn: () => void, intervalMs: () => number): () => void {
  let timer: NodeJS.Timeout | undefined;
  let pending = false;

  const run = () => {
    fn();
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) {
        pending = false;
        run();
      }
    }, intervalMs());
  };

  return () => {
    if (timer) {
      pending = true;
    } else {
      run();
    }
  };
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === "markdown";
}

/** Katalog roboczy serwera: folder workspace'u z dokumentem, a bez niego katalog dokumentu. mdlive szuka .mdlive w górę. */
function workingDirectoryFor(document: vscode.TextDocument): string {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.uri.fsPath);
}

/** Jeden podgląd: panel webview na splicie, serwer mdlive i śledzony dokument. */
export class PreviewSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private document: vscode.TextDocument;
  private sentVersion: number | undefined;
  private sentLine: number | undefined;
  private disposed = false;

  private readonly sendContentThrottled = throttled(() => this.sendContent(false), () => this.throttleMs());
  private readonly sendCursorThrottled = throttled(() => this.sendCursor(false), () => this.throttleMs());

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly server: MdLiveServer,
    readonly workingDirectory: string,
    document: vscode.TextDocument,
    private readonly log: vscode.OutputChannel,
    private readonly onDispose: () => void,
  ) {
    this.document = document;

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      server.onDidExit((code) => {
        void vscode.window
          .showErrorMessage(`MdLive: the server exited (code ${code}).`, "Show Log")
          .then((choice) => choice && this.log.show());
        this.panel.dispose();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document) {
          this.sendContentThrottled();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isMarkdown(editor.document) && editor.document !== this.document) {
          this.track(editor.document);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document === this.document) {
          this.sendCursorThrottled();
        }
      }),
      // Szablon, style i config.csx są czytane przy każdym renderze, więc wystarczy wymusić render
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.fsPath.split(path.sep).includes(".mdlive")) {
          this.sendContent(true);
        }
      }),
    );

    this.panel.webview.html = this.html();
    this.sendContent(true);
    this.sendCursor(true);
  }

  static async open(document: vscode.TextDocument, log: vscode.OutputChannel, onDispose: () => void): Promise<PreviewSession> {
    const config = vscode.workspace.getConfiguration("mdlive");
    const executable = config.get<string>("path", "mdlive");
    const workingDirectory = workingDirectoryFor(document);

    const args = ["serve", "--embedded"];

    // --trust tylko w zaufanym workspace: w Restricted Mode nic z ustawień nie poszerza tego, co się wykona
    if (vscode.workspace.isTrusted) {
      const { dirs, missing } = resolveTrustedDirs(config.get<string[]>("trustedDirs", []));
      for (const dir of dirs) {
        args.push("--trust", dir);
      }

      if (missing.length > 0) {
        void vscode.window.showWarningMessage(`MdLive: mdlive.trustedDirs: skipping missing ${missing.join(", ")}`);
      }
    }

    const server = await MdLiveServer.start(executable, args, workingDirectory, log);

    const panel = vscode.window.createWebviewPanel(
      "mdlive.preview",
      `MdLive: ${path.basename(document.uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Bez retainContextWhenHidden iframe przeładowywałby się przy każdym przełączeniu zakładki
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );

    return new PreviewSession(panel, server, workingDirectory, document, log, onDispose);
  }

  /** Przełącza podgląd na inny dokument markdown. */
  track(document: vscode.TextDocument): void {
    this.document = document;
    this.sentVersion = undefined;
    this.sentLine = undefined;
    this.panel.title = `MdLive: ${path.basename(document.uri.fsPath)}`;
    this.sendContent(true);
    this.sendCursor(true);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /** Wymusza render, np. po zaufaniu config.csx. */
  rerender(): void {
    this.sendContent(true);
  }

  private throttleMs(): number {
    return vscode.workspace.getConfiguration("mdlive").get<number>("throttleMs", 100);
  }

  private sendContent(force: boolean): void {
    if (!force && this.document.version === this.sentVersion) {
      return;
    }

    this.server.sendContent(this.document.uri.fsPath, this.document.getText());
    this.sentVersion = this.document.version;
  }

  private sendCursor(force: boolean): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== this.document) {
      return;
    }

    // Linie w VS Code od 0, w protokole od 1
    const line = editor.selection.active.line + 1;
    if (!force && line === this.sentLine) {
      return;
    }

    this.server.sendCursor(line);
    this.sentLine = line;
  }

  private html(): string {
    const origin = `http://127.0.0.1:${this.server.port}`;
    // Token we fragmencie: nie trafia do serwera ani logów, strona logowania wymienia go na ciasteczko
    // (w --embedded: SameSite=None; Secure; Partitioned, więc działa w tym iframe)
    const src = `${this.server.baseUrl}#${this.server.token}`;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #fff; }
    iframe { border: 0; width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <iframe src="${src}" title="MdLive preview"></iframe>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.server.dispose();
    this.panel.dispose();
    this.onDispose();
  }
}
