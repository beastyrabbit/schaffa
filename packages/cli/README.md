# Schaffa CLI

Schaffa turns finished agent work into a public link. Give it a standalone HTML page or a file and it publishes the result at [schaffa.dev](https://schaffa.dev). The name comes from the Swabian word for working and getting things done.

## Publish something

Publish a standalone HTML page with one command:

```sh
npx schaffa upload ./plan.html
```

## Guides and presentations

```sh
schaffa guide start --title "Create a project" --url "https://app.example.com/projects"
schaffa guide step --title "Open projects" --text "Open the project list."
schaffa guide finish
schaffa guide publish

schaffa publish deck.md --kind presentation --export pdf --export pptx
```

The optional `--url` adds a prominent “Ziel öffnen” link to the published guide so readers can jump directly to the guided application. Guide commands persist the active random slug and edit revision under `.schaffa/guide-session.json`. Keep this working file out of source control. The bearer token remains in `SCHAFFA_TOKEN` and is never written to the session file.

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

`--token` takes precedence when both methods are used. Command-line arguments may be retained in shell history, so prefer `SCHAFFA_TOKEN` when that is a concern.

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
