# Tab Grouper

Chrome MV3 extension inspired by Arc's tidy tabs flow. Click **Tidy tabs** and the extension groups the current window's tabs with local heuristics or, when configured, a local Codex CLI / Claude Code CLI bridge.

## Status

This is an MVP prototype. It avoids automating Claude.ai, ChatGPT, or Codex web sessions. The smart-provider path is a local Native Messaging bridge that invokes the user's already-authenticated `codex` or `claude` CLI without exposing web credentials to the extension.

## Load locally

The extension is written in TypeScript and needs a one-time build before loading:

1. Run `nub install` (installs the TypeScript/esbuild toolchain).
2. Run `nub run build` (compiles `src/*.ts` into `dist/*.js`; re-run this after any source change - `nub run build:watch` rebuilds automatically).
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select this folder: `/Users/fabianpieringer/projects/tab-grouper`.
7. Open the extension options and choose a provider.

The default provider is `Local heuristic`, so the extension works without an API key.

## Local CLI bridge

To use `Local Codex CLI` or `Local Claude Code CLI`, install the native host after loading the unpacked extension:

```sh
nub run native:install
```

The installer derives the pinned extension ID from `manifest.json`, builds the Go native host, and writes the Chrome Native Messaging manifest for `com.fabianpieringer.tab_grouper`.

To install the shared native host for every supported Chromium browser in one step, run:

```sh
nub run native:install --browser all
```

To target only one browser, pass `--browser chrome`, `--browser brave`, `--browser edge`, `--browser chromium`, `--browser chrome-canary`, or `--browser helium` (Helium path unverified).

The installer also writes a locked native-host config beside the built binary with the discovered `codex` and `claude` executable paths. If either CLI is installed somewhere unusual, pass explicit paths:

```sh
nub run native:install --codex-path /path/to/codex --claude-path /path/to/claude
```

Pass `--extension-id <chrome-extension-id>` only when intentionally installing the native host for a different loaded extension.

The native host binary itself is just a thin per-connection proxy: the first request from any browser auto-starts one shared background daemon (a Unix socket under `/tmp`, named from a hash of this checkout's path), which every subsequent request from any browser reuses. There's nothing to start or manage manually; the daemon shuts itself down after 30 minutes of inactivity, and `nub run native:install` restarts it so binary updates take effect immediately.

Re-run `nub run native:install` after pulling changes to `native-host/`. The extension rejects mismatched native-host protocol versions and reports this reinstall command instead of silently using older behavior.

After choosing `Local Codex CLI` or `Local Claude Code CLI` in Options, use **Test bridge** to verify Native Messaging, the pinned CLI path, and sign-in state without running a model request.

## V1 behavior

- Tidies only the current Chrome window.
- Uses native Chrome tab groups instead of a custom workspace UI.
- Leaves pinned tabs and existing tab groups untouched by default.
- Offers an optional plan preview without changing tabs.
- Stores an undo snapshot for the last successful tidy.
- Supports local Codex CLI and local Claude Code CLI provider modes through a Native Messaging bridge.
- Falls back to local heuristic grouping when a smart provider or local bridge fails.
- Times out smart providers and falls back locally instead of leaving tidy stuck.
- Requests OpenAI or Anthropic host access only if that provider is selected.
- Requests Native Messaging permission only if a local CLI provider is selected.
- Supports optional superficial page hints through explicit runtime page-access consent for current-window origins.
- Does not ingest full page contents, browser history, cookies, passwords, form fields, storage, or private chat subscriptions.

## Providers

- `Local heuristic`: no network, groups by common domain/category patterns.
- `Local Codex CLI`: sends tab context to the local Tab Grouper bridge, which invokes the signed-in Codex CLI.
- `Local Claude Code CLI`: sends tab context to the local Tab Grouper bridge, which invokes the signed-in Claude Code CLI.
- `Chrome built-in AI`: experimental Prompt API path for Chrome Extensions. Requires a supported Chrome version and local model availability.
- `OpenAI`: calls `https://api.openai.com/v1/responses` with structured JSON output.
- `Anthropic`: calls `https://api.anthropic.com/v1/messages` and parses JSON text output.

Smart provider calls are bounded to keep the popup workflow responsive. If a provider times out, rejects the request, lacks permission, or is missing configuration, the extension uses local heuristic grouping for that tidy.

## Privacy

The extension reads tab titles and URLs so it can group tabs. Local heuristic grouping may use full URLs on-device for better labels, such as GitHub repository names or localhost ports. When a local CLI or API provider is selected, tab titles and domains are sent by default; full URLs are sent only when explicitly enabled.

When superficial page hints are enabled, the popup requests temporary `scripting` access for exact current-window HTTP/HTTPS origins. The service worker extracts only document title, meta description, Open Graph title/description, and the first few `h1`/`h2` headings with strict caps, then removes that page-access permission after collecting hints.

Local CLI providers send tab context to a native app on this computer. That native app then invokes the install-time pinned `codex` or `claude` executable as the signed-in local user with fixed arguments, no shell, a timeout, and strict JSON plan parsing. The extension does not store or request Claude/OpenAI web credentials and does not scrape browser cookies.

Prototype API keys are stored in `chrome.storage.local`. That is acceptable for local testing but not a strong production secret-management story.

OpenAI and Anthropic network permissions are optional Chrome host permissions. Local-only users are not asked to grant API host access.

## Test

```sh
nub run test
```

This runs JavaScript tests, manifest validation, Go native-host tests, and a framed native-host E2E smoke test with a fake pinned Codex executable.

## Chrome smoke test

```sh
nub run smoke:chrome
```

The smoke test opens a temporary Chrome profile, loads a temporary unpacked copy of this extension through Chrome DevTools Protocol, verifies heuristic tidy/undo, installs a temporary Native Messaging host with a fake pinned Codex executable, verifies local Codex provider tidy/undo with superficial page hints, then restores the Chrome native-host manifest. Set `CHROME_PATH` if Chrome is installed somewhere other than `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
