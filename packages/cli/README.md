# Schaffa CLI

Schaffa turns finished agent work into a public link. Give it a standalone HTML page or a file and it publishes the result at [schaffa.dev](https://schaffa.dev). The name comes from the Swabian word for working and getting things done.

## Publish something

Publish a standalone HTML page with one command:

```sh
npx schaffa upload ./plan.html
```

## Guides and presentations

```sh
# Automatic browser or macOS desktop capture
schaffa record --title "Create a project" --chrome "https://app.example.com/projects"
schaffa record --title "Configure Calculator" --desktop --app com.apple.calculator

# Inspect and correct an active recording
schaffa guide status --json
schaffa guide edit-step --step 2 --title "Choose New project"
schaffa guide replace-screenshot --step 2 --screenshot ./correct-step.png
schaffa guide delete-step --step 3

# Manual capture remains useful for mixed terminal/browser workflows
schaffa guide start --title "Create a project" --url "https://app.example.com/projects"
schaffa guide step --title "Open projects" --text "Open the project list."
schaffa guide finish

schaffa publish deck.md --kind presentation --export pdf --export pptx
```

Each requested PDF or PowerPoint export is linked from a compact download bar in the published
presentation. The bar is hidden when no export format is requested.

Chrome mode opens a new window in the already running Google Chrome without
creating a profile. Chrome uses one of its existing profile sessions, so that
session's logins, extensions, and password manager remain available. The native
recorder binds to that exact window and ignores other Chrome work. The isolated
`--browser` mode remains available when a separate persistent Schaffa browser
profile is wanted. Desktop mode records native macOS windows without
opening a browser tab, is restricted to the application selected by `--app`,
and requires one-time Accessibility and Screen Recording permission. Typed
values and keystrokes are excluded from event metadata, but
visible form contents can still appear in screenshots.
Every primary click gets a visible red target outline and compact cursor.
Original JPEG or PNG captures and an upload manifest are retained under
`.schaffa/recordings/<slug>/`; run
`schaffa guide sync` after a network failure. Close the browser or press Ctrl+C
to stop and publish automatically, and use `Alt+Shift+R` to pause capture on
private screens. Edits to an already published guide automatically create a new
immutable revision.

`schaffa guide replace-screenshot` cleans the supplied image but does not
recreate a recorder cursor or target outline. Add those annotations to the
replacement image before uploading it when needed.

The earlier `schaffa guide record --title ... --url ...` form remains supported.
The short command is `npx schaffa record`, not literal `npx record`: the latter
would require a separate generic npm package named `record`.

The optional `--url` adds a prominent “Ziel öffnen” link to the published guide so readers can jump directly to the guided application. Guide commands persist the active random slug and edit revision under `.schaffa/guide-session.json`. Keep these working files out of source control. The bearer token is never written to the session file.

The command prints the stable public URL immediately. Until the asynchronous virus scan completes, that URL shows a self-refreshing status page; clean content appears at the same URL. New HTML pages can be published without an account; anonymous pages remain public for one hour and are deleted after 30 days.

Other file types are published as files and require a token:

```sh
npx schaffa upload ./diagram.png --token "sfa_…"
```

## Use a token

A token is required for permanent HTML pages and file uploads.

```sh
# Automatically read from the environment
export SCHAFFA_TOKEN="sfa_…"
npx schaffa upload ./plan.html

# Or pass it directly
npx schaffa upload ./plan.html --token "sfa_…"
```

All CLI commands look for a token automatically, in this order:

1. `--token <token>`.
2. The `SCHAFFA_TOKEN` environment variable.
3. `.env.local`, then `.env`, in the current directory.
4. `token`, `config.json`, then `.env` inside each of these directories: `./.schaffa/`, `$XDG_CONFIG_HOME/schaffa/` or `~/.config/schaffa/` by default, then `~/.schaffa/`.

The first nonempty token wins. A `token` file contains the plain token. JSON accepts `{"token":"sfa_…"}` or `{"SCHAFFA_TOKEN":"sfa_…"}`. Environment files use `SCHAFFA_TOKEN=sfa_…`; quotes, comments, and an `export` prefix are supported. Files are parsed without running shell commands or loading unrelated environment variables. Lookup stays in the listed locations and does not search parent directories. Unreadable files or invalid config JSON stop the command.

To skip all token lookup and publish a temporary anonymous HTML page:

```sh
npx schaffa upload ./plan.html --ignore-token
```

`--ignore-token` cannot be combined with `--token`. Files, presentations, guides, and interactive pages still require authentication. Keep token files out of Git. Command-line arguments may be retained in shell history, so prefer the environment or a local config file.

Every new page receives a random, non-semantic ID. Add `--json` to print the complete API response instead of only the public URL.

## Publish trusted interactive HTML

Interactive pages are available only after the instance administrator enables the feature and grants your account permission. Create a separate Interactive token in the account page, then run:

```sh
export SCHAFFA_TOKEN="sfa_…"
npx schaffa upload ./interactive-plan.html --interactive
```

Visitors see a warning before the page runs. Schaffa allows inline JavaScript but isolates it without network, browser storage, forms, pop-ups, or navigation. The interactive token cannot upload static pages or files.

## Get a token

1. Sign in at [schaffa.dev/account](https://schaffa.dev/account).
2. Open the token section and create an upload token, or an Interactive token when your account has been approved.
3. Copy the token when it is shown. Schaffa displays it only once.
4. Store it in your secret manager or export it as `SCHAFFA_TOKEN`.

Treat tokens like passwords. Do not commit them to Git or include them in published pages. If a token is exposed, revoke it in your account and create a replacement.
