# MdLive for VS Code

Live preview of Markdown rendered by [MdLive](https://github.com/ScuroGuardiano/MdLive) with **your own**
Markdig pipeline, template and styles from `.mdlive/`, in a split next to the editor. It updates as you type and
keeps the block under the cursor in view.

## Requirements

The `mdlive` tool (needs the .NET 11 runtime):

```sh
dotnet tool install -g ScuroGuardiano.MdLive
```

It needs an `mdlive` with `serve --embedded` (0.4.0 or newer). Make sure `~/.dotnet/tools` is in your `PATH`,
or set `mdlive.path`.

## Usage

Open a Markdown file and run **MdLive: Open Preview to the Side**, or use the preview button in the editor title.
Switching to another Markdown file switches the preview to it. Saving a file in `.mdlive/` re-renders it.

| Command                               | Description                                                     |
|---------------------------------------|-----------------------------------------------------------------|
| MdLive: Open Preview to the Side      | Start `mdlive serve` for the workspace and show the preview     |
| MdLive: Stop Preview                  | Close the preview and stop the server                           |
| MdLive: Trust Config Script           | Review the files `.mdlive/config.csx` consists of and trust them |
| MdLive: Show Log                      | The server's log                                                |

## Settings

| Setting              | Default    | Description                                                                 |
|----------------------|------------|-----------------------------------------------------------------------------|
| `mdlive.path`        | `"mdlive"` | Path to the `mdlive` executable.                                            |
| `mdlive.trustedDirs` | `[]`       | Directories where `.mdlive/config.csx` runs without trusting it first (`mdlive serve --trust`). `~`, `${userHome}` and `${env:NAME}` are expanded, missing directories are skipped. |
| `mdlive.throttleMs`  | `100`      | Minimal interval between updates while typing.                              |

`mdlive.path` and `mdlive.trustedDirs` can only be set in **user** settings. A repository's
`.vscode/settings.json` can't point the extension at a program of its own or mark itself as trusted.

## Security

- **`config.csx` is code.** It runs only once trusted (MdLive: Trust Config Script, or `mdlive trust`), or when
  it's under one of `mdlive.trustedDirs`. See
  [docs/scripting.md](https://github.com/ScuroGuardiano/MdLive/blob/master/docs/scripting.md#security).
- **Workspace Trust.** In Restricted Mode the preview works, but `mdlive.trustedDirs` isn't applied and the
  trust command is disabled.
- **The preview server** listens only on `127.0.0.1`, and every request needs a session. The extension frames the
  preview with `mdlive serve --embedded`:
  - the session cookie is `SameSite=None; Secure; Partitioned`, so it's kept only for VS Code, and a website
    framing the preview gets nothing,
  - `frame-ancestors 'self' vscode-webview: vscode-file:` lets only VS Code webviews frame it.

## Limitations

Local VS Code only for now. With Remote SSH, WSL or Codespaces the server would run on the remote machine, and
its port would need forwarding into the webview.

## Development

```sh
npm install
npm run compile
npm run test:e2e   # real VS Code under xvfb-run, needs mdlive with --embedded in PATH
npm run package    # mdlive-<version>.vsix
```

`test/e2e.mjs` drives VS Code through Playwright. It opens the preview, reads the framed page inside the webview,
types in the editor, reloads the webview (the session has to survive on the partitioned cookie), and checks
`mdlive.trustedDirs`. With `MDLIVE_E2E_RESTRICTED=1` it runs the same in Restricted Mode.
