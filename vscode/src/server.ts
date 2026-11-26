import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";

/** Pierwsza linia na stdout `mdlive serve`. */
interface ServerInfo {
  port: number;
  token: string;
}

/**
 * Proces `mdlive serve --embedded`. Protokół jak w pluginie neovima (docs/neovim.md#protocol):
 * jedna linia JSON na stdout z portem i tokenem, potem wiadomości JSON po jednej na linię na stdin,
 * logi na stderr, zamknięcie stdin kończy serwer.
 */
export class MdLiveServer implements vscode.Disposable {
  private readonly exitEmitter = new vscode.EventEmitter<number | null>();

  /** Kod wyjścia, gdy serwer zakończył się sam (null przy zabiciu sygnałem). */
  readonly onDidExit = this.exitEmitter.event;

  private disposed = false;

  private constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    readonly port: number,
    readonly token: string,
  ) {
    process.once("exit", (code) => {
      if (!this.disposed) {
        this.exitEmitter.fire(code);
      }
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  static start(executable: string, args: string[], cwd: string, log: vscode.OutputChannel): Promise<MdLiveServer> {
    return new Promise((resolve, reject) => {
      log.appendLine(`> ${[executable, ...args].join(" ")}  (cwd: ${cwd})`);

      // Bez powłoki: ścieżki z ustawień trafiają do procesu dosłownie
      const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      child.once("error", (error) => fail(error));
      child.once("exit", (code) => fail(new Error(`mdlive exited with code ${code} before it started, see MdLive: Show Log`)));

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => log.append(chunk));

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) {
          return;
        }

        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) {
          return;
        }

        try {
          const info = JSON.parse(stdout.slice(0, newline)) as ServerInfo;
          if (typeof info.port !== "number" || typeof info.token !== "string") {
            throw new Error("missing port or token");
          }

          settled = true;
          resolve(new MdLiveServer(child, info.port, info.token));
        } catch (error) {
          child.kill();
          fail(new Error(`Unexpected first line from mdlive: ${stdout.slice(0, newline)}`));
        }
      });
    });
  }

  sendContent(path: string, text: string): void {
    this.send({ type: "content", path, text });
  }

  sendCursor(line: number): void {
    this.send({ type: "cursor", line });
  }

  /**
   * Scroll sync: linia źródła (1-based, ułamkowa) i wysokość, na której ma stanąć w podglądzie (0 góra, 1 dół).
   * anchor dla starszych mdlive, które nie znają position: najbliższa z dwóch obsługiwanych wysokości.
   */
  sendScroll(line: number, position: number): void {
    this.send({ type: "scroll", line, position, anchor: position < 0.25 ? "top" : "center" });
  }

  private send(message: object): void {
    if (!this.disposed && this.process.stdin.writable) {
      this.process.stdin.write(JSON.stringify(message) + "\n");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.exitEmitter.dispose();

    // Zamknięcie stdin to sygnał dla serwera, żeby się zakończył; kill na wypadek, gdyby nie zdążył
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill(), 3000);
    this.process.once("exit", () => clearTimeout(timer));
  }
}
