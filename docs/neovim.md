# MdLive for Neovim

Live preview of Markdown rendered by `mdlive serve`, so the browser shows exactly what your
Markdig pipeline and `.mdlive` styles produce. Requires Neovim 0.10+.

## Install

1. Install the `mdlive` tool:

   ```sh
   dotnet tool install -g ScuroGuardiano.MdLive
   ```

   Make sure `~/.dotnet/tools` is in your `PATH`.

2. Add the plugin. `lua/` and `plugin/` are at the root of this repository, so plugin managers can
   use it directly, e.g. [lazy.nvim](https://github.com/folke/lazy.nvim):

   ```lua
   {
     "ScuroGuardiano/MdLive",
     ft = "markdown",
     cmd = { "MdLiveStart", "MdLiveStop", "MdLiveOpen", "MdLiveLog", "MdLiveTrust" },
     opts = {},
   }
   ```

   When working on the plugin itself, point lazy.nvim at the checkout instead:
   `dir = "~/src/MdLive"` in place of the repository.

   Without a plugin manager: `vim.opt.rtp:append("~/src/MdLive")` and
   `require("mdlive").setup()`.

3. Optionally run `mdlive init` in your project to create `.mdlive/` with an editable
   `style.css` and `template.html`.

## Commands

| Command        | Description                                                      |
|----------------|------------------------------------------------------------------|
| `:MdLiveStart` | Start the server for the current Markdown buffer, open browser   |
| `:MdLiveStop`  | Stop the server                                                  |
| `:MdLiveOpen`  | Open the preview in the browser again                            |
| `:MdLiveLog`   | Show the server's stderr                                         |
| `:MdLiveTrust` | Review and trust `.mdlive/config.csx`, see below                 |

The server runs with Neovim's current directory as its working directory, so `.mdlive/` is
looked up there and in its parent directories. Switching to another Markdown buffer switches the preview to it.
Saving a file in `.mdlive/` re-renders the preview, picking up style and template changes.

### Trusting `config.csx`

A C# config script ([docs/scripting.md](https://github.com/ScuroGuardiano/MdLive/blob/master/docs/scripting.md)) runs only
once trusted. Until then the preview uses the default config and shows a banner. `:MdLiveTrust` lists every
file the config consists of with its SHA-256 and offers:

- **Trust:** runs `mdlive trust --hash <hash of the shown list>`, so if anything changed in the meantime,
  nothing is trusted. The preview re-renders with the script right away,
- **Review:** puts the files on the quickfix list. Read them, then run `:MdLiveTrust` again,
- **Cancel.**

Editing any of the files makes the config untrusted again, and the preview falls back to the default.

In directories only you write to, such as your notes, skip this with the `trusted_dirs` option, e.g.
`trusted_dirs = { "~/notes" }`. A config under one of them runs right away and `:MdLiveTrust` says so.
Don't list a directory you clone other people's repositories into. Needs an `mdlive` with `serve --trust`,
older versions ignore the option.
## Options

Defaults:

```lua
require("mdlive").setup({
  -- Command starting the server
  cmd = { "mdlive", "serve" },
  -- Minimal interval between updates while typing
  throttle_ms = 100,
  -- Open the browser once the server reports its port
  open_browser = true,
  -- File types sent to the preview
  filetypes = { "markdown" },
  -- How many lines of server stderr to keep for :MdLiveLog
  log_lines = 500,
  -- Directories where .mdlive/config.csx runs without :MdLiveTrust (passed as mdlive serve --trust).
  -- Only ones nobody else writes to. ~ and $VARIABLES are expanded, missing directories skipped.
  trusted_dirs = {},
})
```

## Protocol

The plugin talks to `mdlive serve` over stdio:

- **stdout**: the server prints a single JSON line, `{"port":12345,"token":"..."}`, with the port
  it listens on, on `127.0.0.1`, and an access token. The preview is opened as
  `http://127.0.0.1:<port>/#<token>`: the page exchanges the token for a session cookie and
  removes it from the address bar. The cookie is a session cookie, gone when the browser closes,
  and both secrets are generated anew on every server start. Without the cookie the server
  answers only the login page, everything else is `401`.
- **stdin**: one JSON message per line:
  - `{"type":"content","path":"/abs/file.md","text":"..."}`, the whole buffer,
  - `{"type":"cursor","line":42}`, 1-based cursor line. The preview brings the block with the cursor to the
    middle of the screen (what this plugin uses),
  - `{"type":"scroll","line":120.5}`, the source line at the top of the editor, 1-based, may be fractional.
    The preview puts that line at its top, interpolating between blocks with `data-line`, and does it again
    after every content change. Editors that follow their own scrolling (the VS Code extension) send this
    instead of `cursor`.
- Closing stdin stops the server. Logs go to stderr.
- **Preview to editor** (only when the preview is framed, `--embedded`): when the user scrolls the preview
  (wheel, keyboard, dragging the scrollbar), the page sends the parent frame
  `postMessage({ type: "mdlive.scroll", line: 120.5 })` with the source line now at its top. Scrolling caused
  by `scroll` messages or by content changes isn't reported, so editor and preview don't keep moving each other.

## Moving from SGLibCS

The plugin used to live in the `mdlive/nvim` branch of
[ScuroGuardiano/SGLibCS](https://github.com/ScuroGuardiano/SGLibCS). That branch isn't updated anymore.
In lazy.nvim replace

```lua
"ScuroGuardiano/SGLibCS", branch = "mdlive/nvim", name = "mdlive",
```

with `"ScuroGuardiano/MdLive",` and run `:Lazy sync`.
