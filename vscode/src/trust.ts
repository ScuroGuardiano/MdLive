import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Katalogi z `mdlive.trustedDirs` jako prawdziwe ścieżki. Nieistniejące są pomijane, bo te same
 * ustawienia (Settings Sync) trafiają na maszyny, gdzie takiego katalogu nie ma.
 */
export function resolveTrustedDirs(configured: readonly string[]): { dirs: string[]; missing: string[] } {
  const dirs: string[] = [];
  const missing: string[] = [];

  for (const entry of configured) {
    const expanded = entry
      .replace(/^~(?=$|[\\/])/, os.homedir())
      .replace(/\$\{userHome\}/g, os.homedir())
      .replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");

    try {
      const real = fs.realpathSync(path.resolve(expanded));
      if (fs.statSync(real).isDirectory() && !dirs.includes(real)) {
        dirs.push(real);
      }
    } catch {
      missing.push(entry);
    }
  }

  return { dirs, missing };
}

/** Katalog obejmujący `target` (prawdziwą ścieżkę), z granicą na separatorze: ~/notes nie obejmuje ~/notes-old. */
export function coveringDir(target: string, dirs: readonly string[]): string | undefined {
  return dirs.find((dir) => target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
}

interface TrustListing {
  directory: string;
  hash: string;
  status: "trusted" | "untrusted" | "changed" | "storerejected";
  problem: string | null;
  files: { path: string; fullPath: string; kind: "source" | "reference"; sha256: string; size: number }[];
  frameworkReferences: string[];
  errors: string[];
  warnings?: string[];
}

function run(executable: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(executable, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Odpowiednik :MdLiveTrust z pluginu neovima: pokazuje pliki configu z hashami i ufa dokładnie tej
 * liście (`mdlive trust --hash`), więc zmiana w trakcie przeglądania niczego nie zaufa.
 * Zwraca true, gdy coś zostało zaufane.
 */
export async function trustConfig(executable: string, cwd: string, trustedDirs: readonly string[]): Promise<boolean> {
  const show = await run(executable, ["trust", "--show", "--json"], cwd);
  if (show.code !== 0) {
    void vscode.window.showErrorMessage(`MdLive: ${show.stderr.trim() || "mdlive trust failed"}`);
    return false;
  }

  let info: TrustListing;
  try {
    info = JSON.parse(show.stdout) as TrustListing;
  } catch {
    void vscode.window.showErrorMessage("MdLive: unexpected output of mdlive trust --show --json");
    return false;
  }

  if (info.errors.length > 0) {
    void vscode.window.showErrorMessage(`MdLive: fix config.csx first: ${info.errors.join("; ")}`);
    return false;
  }

  if (info.status === "trusted") {
    void vscode.window.showInformationMessage(`MdLive: ${info.directory} is already trusted.`);
    return false;
  }

  const covering = coveringDir(info.directory, trustedDirs);
  if (covering) {
    void vscode.window.showInformationMessage(`MdLive: ${info.directory} is trusted by mdlive.trustedDirs (${covering}).`);
    return false;
  }

  if (info.status === "storerejected") {
    void vscode.window.showErrorMessage(`MdLive: ${info.problem}`);
    return false;
  }

  const lines = info.files.map((f) => `${f.kind.padEnd(9)} ${f.sha256.slice(0, 12)}  ${f.path}`);
  lines.push(...info.frameworkReferences.map((name) => `framework ${name}`));

  const choice = await vscode.window.showWarningMessage(
    info.status === "changed" ? "config.csx changed since it was trusted." : "config.csx is not trusted.",
    {
      modal: true,
      detail: `Trust and run this code with your permissions?\n\n${info.directory}\n${lines.join("\n")}`,
    },
    "Trust",
    "Review",
  );

  if (choice === "Review") {
    for (const file of info.files.filter((f) => f.kind === "source")) {
      await vscode.window.showTextDocument(vscode.Uri.file(file.fullPath), { preview: false, preserveFocus: true });
    }

    void vscode.window.showInformationMessage("MdLive: review the files, then run MdLive: Trust Config Script again.");
    return false;
  }

  if (choice !== "Trust") {
    return false;
  }

  const trust = await run(executable, ["trust", "--hash", info.hash], cwd);
  if (trust.code === 0) {
    void vscode.window.showInformationMessage(`MdLive: trusted ${info.directory}.`);
    return true;
  }

  if (trust.code === 2) {
    void vscode.window.showWarningMessage("MdLive: config changed while you were reviewing it, nothing trusted. Run the command again.");
  } else {
    void vscode.window.showErrorMessage(`MdLive: ${trust.stderr.trim()}`);
  }

  return false;
}
