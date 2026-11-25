import { randomBytes } from "node:crypto";
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
  /** Linia z góry edytora wysłana ostatnio do podglądu (1-based). */
  private sentScrollLine: number | undefined;
  /** Do tej chwili zmiany widocznego zakresu edytora pochodzą z revealRange po przewinięciu podglądu. */
  private ignoreEditorScrollUntil = 0;
  /** Trwające odsłanianie linii z podglądu w edytorze, z poprawkami na sticky scroll. */
  private revealing: { target: number; requested: number; corrections: number } | undefined;
  private disposed = false;

  private readonly sendContentThrottled = throttled(() => this.sendContent(false), () => this.throttleMs());
  private readonly sendScrollThrottled = throttled(() => this.sendScroll(false), () => this.throttleMs());

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
      // Scroll sync jak we wbudowanym podglądzie: góra edytora -> góra podglądu (a nie pozycja kursora)
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor.document !== this.document) {
          return;
        }

        if (Date.now() < this.ignoreEditorScrollUntil) {
          this.correctReveal(e.textEditor, e.visibleRanges);
          return;
        }

        this.revealing = undefined;
        this.sendScrollThrottled();
      }),
      // ... i w drugą stronę: przewinięcie podglądu przez użytkownika przewija edytor
      panel.webview.onDidReceiveMessage((message: unknown) => this.onPreviewMessage(message)),
      // Szablon, style i config.csx są czytane przy każdym renderze, więc wystarczy wymusić render
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.fsPath.split(path.sep).includes(".mdlive")) {
          this.sendContent(true);
        }
      }),
    );

    this.panel.webview.html = this.html();
    this.sendContent(true);
    this.sendScroll(true);
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
    this.sentScrollLine = undefined;
    this.panel.title = `MdLive: ${path.basename(document.uri.fsPath)}`;
    this.sendContent(true);
    this.sendScroll(true);
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

  /** Edytor z tym dokumentem: aktywny, a jeśli podgląd ma fokus, ten widoczny obok. */
  private editor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    return active?.document === this.document
      ? active
      : vscode.window.visibleTextEditors.find((editor) => editor.document === this.document);
  }

  private sendScroll(force: boolean): void {
    const range = this.editor()?.visibleRanges[0];
    if (!range) {
      return;
    }

    // Linie w VS Code od 0, w protokole od 1
    const line = range.start.line + 1;
    if (!force && line === this.sentScrollLine) {
      return;
    }

    this.server.sendScroll(line);
    this.sentScrollLine = line;
  }

  private onPreviewMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }

    const { type, line } = message as { type?: unknown; line?: unknown };
    if (type !== "scroll" || typeof line !== "number" || !Number.isFinite(line)) {
      return;
    }

    const editor = this.editor();
    if (!editor) {
      return;
    }

    const target = Math.min(Math.max(Math.floor(line), 1), this.document.lineCount);
    this.sentScrollLine = target;
    this.revealing = { target, requested: target, corrections: 0 };
    this.revealAtTop(editor, target);

    // Serwer odtwarza ostatnią linię po każdej zmianie treści, więc musi znać tę z podglądu, a nie starą
    // z edytora. Dokładna wartość: strona już tam jest, więc jej scrollToLine nic nie zrobi.
    this.server.sendScroll(line);
  }

  private revealAtTop(editor: vscode.TextEditor, line: number): void {
    // revealRange zmieni widoczny zakres, a to nie może wrócić do podglądu jako przewinięcie edytora
    this.ignoreEditorScrollUntil = Date.now() + 300;
    editor.revealRange(new vscode.Range(line - 1, 0, line - 1, 0), vscode.TextEditorRevealType.AtTop);
  }

  /**
   * Sticky scroll (domyślnie włączony, w markdownie przypina nagłówki) sprawia, że AtTop stawia linię pod
   * przypiętymi nagłówkami, więc góra okna wypada kilka linii wyżej. W drugą stronę liczymy górę okna
   * (visibleRanges), więc tu też: odsłaniamy dalej o tyle, o ile się rozjechało. Najwyżej dwa razy,
   * bo liczba przypiętych nagłówków może się przy tym zmienić.
   */
  private correctReveal(editor: vscode.TextEditor, visibleRanges: readonly vscode.Range[]): void {
    const reveal = this.revealing;
    const top = visibleRanges[0]?.start.line;
    if (!reveal || top === undefined) {
      return;
    }

    const difference = reveal.target - (top + 1);
    if (difference === 0 || reveal.corrections >= 2) {
      this.revealing = undefined;
      return;
    }

    reveal.corrections++;
    reveal.requested = Math.min(Math.max(reveal.requested + difference, 1), this.document.lineCount);
    this.revealAtTop(editor, reveal.requested);
  }

  private html(): string {
    const origin = `http://127.0.0.1:${this.server.port}`;
    // Token we fragmencie: nie trafia do serwera ani logów, strona logowania wymienia go na ciasteczko
    // (w --embedded: SameSite=None; Secure; Partitioned, więc działa w tym iframe)
    const src = `${this.server.baseUrl}#${this.server.token}`;
    const nonce = randomBytes(16).toString("base64");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #fff; }
    iframe { border: 0; width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <iframe src="${src}" title="MdLive preview"></iframe>
  <script nonce="${nonce}">
    // Przekaźnik scroll sync: podgląd (inny origin) -> rozszerzenie. Tylko z naszej ramki i tylko numer linii.
    const vscode = acquireVsCodeApi();
    const frame = document.querySelector("iframe");
    window.addEventListener("message", (event) => {
      if (event.origin !== "${origin}" || event.source !== frame.contentWindow) {
        return;
      }
      const data = event.data;
      if (data && data.type === "mdlive.scroll" && Number.isFinite(data.line)) {
        vscode.postMessage({ type: "scroll", line: data.line });
      }
    });
  </script>
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
