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

/** Widoczny zakres edytora jako linie 0-based: pierwsza widoczna i liczba linii do ostatniej. */
function visibleSpan(visibleRanges: readonly vscode.Range[]): { first: number; span: number } | undefined {
  const first = visibleRanges[0];
  const last = visibleRanges[visibleRanges.length - 1];
  if (!first || !last) {
    return undefined;
  }

  return { first: first.start.line, span: Math.max(1, last.end.line - first.start.line) };
}

/**
 * Linia źródła (1-based, ułamkowa) na danej wysokości edytora: 0 to góra, 0.5 środek, 1 dół.
 * Ta sama definicja w obie strony: przy wysyłaniu do podglądu i przy sprawdzaniu, gdzie wylądował revealRange.
 */
function lineAt(visibleRanges: readonly vscode.Range[], position: number): number | undefined {
  const visible = visibleSpan(visibleRanges);
  return visible && visible.first + position * visible.span + 1;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Ile po ruchu kursora zmiana widocznego zakresu (albo kursora po przewinięciu) uchodzi za jego skutek. */
const CAUSED_BY_MS = 150;

/** Jeden podgląd: panel webview na splicie, serwer mdlive i śledzony dokument. */
export class PreviewSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private document: vscode.TextDocument;
  private sentVersion: number | undefined;
  /** Linia (1-based) i jej wysokość (0-1) wysłane ostatnio do podglądu. */
  private sentScroll: { line: number; position: number } | undefined;
  /** Do tej chwili zmiany widocznego zakresu edytora pochodzą z revealRange po przewinięciu podglądu. */
  private ignoreEditorScrollUntil = 0;
  /** Trwające odsłanianie linii z podglądu w edytorze, z poprawkami na sticky scroll. */
  private revealing: { target: number; requested: number; corrections: number; position: number } | undefined;
  /**
   * Co wyrównuje scroll sync: linię z kursorem ("cursor", po ruchu kursora: klawiatura, Vim, pisanie, klik)
   * albo stałą wysokość widoku ("view", po przewinięciu kółkiem, scrollbarem albo z podglądu).
   */
  private follow: "cursor" | "view" = "view";
  private lastCursorMoveAt = 0;
  private lastViewScrollAt = 0;
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
      // Scroll sync: przewinięcie edytora przewija podgląd
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor.document !== this.document) {
          return;
        }

        const now = Date.now();
        if (now < this.ignoreEditorScrollUntil) {
          this.correctReveal(e.textEditor, e.visibleRanges);
          return;
        }

        this.revealing = undefined;
        // Kursor wyjechał za krawędź i VS Code przewinął za nim: dalej wyrównujemy kursor
        if (now - this.lastCursorMoveAt > CAUSED_BY_MS) {
          this.follow = "view";
          this.lastViewScrollAt = now;
        }

        this.sendScrollThrottled();
      }),
      // ... i ruch kursora też, bo w obrębie widoku nie zmienia widocznego zakresu
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const now = Date.now();
        if (
          e.textEditor.document !== this.document ||
          !this.followCursor() ||
          // Kursor przesunięty przez samo przewinięcie (VSCodeVim trzyma go w widoku, scrolloff) to nie ruch kursora
          now < this.ignoreEditorScrollUntil ||
          now - this.lastViewScrollAt <= CAUSED_BY_MS
        ) {
          return;
        }

        this.follow = "cursor";
        this.lastCursorMoveAt = now;
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
    this.sentScroll = undefined;
    this.follow = "view";
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

  /** Wysokość z mdlive.scrollAnchor, na której wyrównywany jest widok, gdy nie podążamy za kursorem. */
  private viewPosition(): number {
    return vscode.workspace.getConfiguration("mdlive").get<string>("scrollAnchor", "center") === "top" ? 0 : 0.5;
  }

  private followCursor(): boolean {
    return vscode.workspace.getConfiguration("mdlive").get<boolean>("followCursor", true);
  }

  /**
   * Co wysłać do podglądu: po ruchu kursora jego linia na tej wysokości, na której jest w edytorze (środek linii),
   * a po przewinięciu linia na wysokości z mdlive.scrollAnchor. Undefined, gdy nie ma czego wysyłać.
   */
  private scrollTarget(editor: vscode.TextEditor): { line: number; position: number } | undefined {
    const visible = visibleSpan(editor.visibleRanges);
    if (!visible) {
      return undefined;
    }

    if (this.follow === "cursor" && this.followCursor()) {
      const cursor = editor.selection.active.line;
      const inView = editor.visibleRanges.some((range) => range.start.line <= cursor && cursor <= range.end.line);
      if (!inView) {
        // Kursor za krawędzią: VS Code zaraz przewinie za nim, wtedy wyślemy właściwą wysokość
        return undefined;
      }

      const middle = cursor + 0.5;
      return { line: middle + 1, position: clamp((middle - visible.first) / visible.span, 0, 1) };
    }

    const position = this.viewPosition();
    return { line: visible.first + position * visible.span + 1, position };
  }

  private sendScroll(force: boolean): void {
    const editor = this.editor();
    const target = editor && this.scrollTarget(editor);
    if (!target) {
      return;
    }

    const sent = this.sentScroll;
    if (!force && sent && sent.line === target.line && sent.position === target.position) {
      return;
    }

    this.server.sendScroll(target.line, target.position);
    this.sentScroll = target;
  }

  private onPreviewMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }

    const { type, line, position: rawPosition } = message as { type?: unknown; line?: unknown; position?: unknown };
    if (type !== "scroll" || typeof line !== "number" || !Number.isFinite(line)) {
      return;
    }

    const editor = this.editor();
    if (!editor) {
      return;
    }

    // Wysokość z podglądu: ta, którą ostatnio mu wysłaliśmy. Przewinięcie podglądu to przewinięcie widoku.
    const position = typeof rawPosition === "number" && Number.isFinite(rawPosition) ? clamp(rawPosition, 0, 1) : this.viewPosition();
    this.follow = "view";
    this.sentScroll = { line, position };
    this.revealing = { target: line, requested: this.topLineFor(editor, line, position), corrections: 0, position };
    this.revealInEditor(editor, this.revealing.requested);

    // Serwer odtwarza ostatnią linię po każdej zmianie treści, więc musi znać tę z podglądu, a nie starą
    // z edytora. Dokładna wartość: strona już tam jest, więc jej scrollToLine nic nie zrobi.
    this.server.sendScroll(line, position);
  }

  /** Górna linia (1-based), przy której `line` wypada na wysokości `position` przy obecnej wysokości edytora. */
  private topLineFor(editor: vscode.TextEditor, line: number, position: number): number {
    const span = visibleSpan(editor.visibleRanges)?.span ?? 0;
    return clamp(Math.round(line - position * span), 1, this.document.lineCount);
  }

  private revealInEditor(editor: vscode.TextEditor, topLine: number): void {
    // revealRange zmieni widoczny zakres, a to nie może wrócić do podglądu jako przewinięcie edytora.
    // VSCodeVim przesuwa przy tym kursor do widoku, a to nie może wrócić jako ruch kursora.
    this.ignoreEditorScrollUntil = Date.now() + 300;
    editor.revealRange(new vscode.Range(topLine - 1, 0, topLine - 1, 0), vscode.TextEditorRevealType.AtTop);
  }

  /**
   * revealRange nie zawsze trafia dokładnie tam, gdzie liczymy: sticky scroll (domyślnie włączony, w markdownie
   * przypina nagłówki) sprawia, że AtTop stawia linię pod przypiętymi nagłówkami, więc góra okna wypada kilka
   * linii wyżej, a liczba linii w oknie bywa inna niż przed przewinięciem. Mierzymy linię na tej wysokości tak
   * samo jak przy wysyłaniu (lineAt) i odsłaniamy dalej o tyle, o ile się rozjechało. Najwyżej dwa razy, bo liczba
   * przypiętych nagłówków może się przy tym zmienić, a przy początku dokumentu nie da się przewinąć wyżej.
   */
  private correctReveal(editor: vscode.TextEditor, visibleRanges: readonly vscode.Range[]): void {
    const reveal = this.revealing;
    const current = reveal && lineAt(visibleRanges, reveal.position);
    if (!reveal || current === undefined) {
      return;
    }

    const difference = Math.round(reveal.target - current);
    if (difference === 0 || reveal.corrections >= 2) {
      this.revealing = undefined;
      return;
    }

    reveal.corrections++;
    reveal.requested = clamp(reveal.requested + difference, 1, this.document.lineCount);
    this.revealInEditor(editor, reveal.requested);
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
    // Przekaźnik scroll sync: podgląd (inny origin) -> rozszerzenie. Tylko z naszej ramki i tylko liczby.
    const vscode = acquireVsCodeApi();
    const frame = document.querySelector("iframe");
    window.addEventListener("message", (event) => {
      if (event.origin !== "${origin}" || event.source !== frame.contentWindow) {
        return;
      }
      const data = event.data;
      if (data && data.type === "mdlive.scroll" && Number.isFinite(data.line)) {
        // position: wysokość linii w oknie (0-1); starsze mdlive wysyłają tylko anchor
        const position = Number.isFinite(data.position) ? data.position : data.anchor === "center" ? 0.5 : 0;
        vscode.postMessage({ type: "scroll", line: data.line, position });
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
