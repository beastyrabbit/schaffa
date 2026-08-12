# Schaffa CLI

Schaffa turns finished agent work into a public link. Give it a standalone HTML page or a file and it publishes the result at [schaffa.dev](https://schaffa.dev). The name comes from the Swabian word for working and getting things done.

## Publish something

Publish a standalone HTML page with one command:

```sh
npx schaffa upload ./plan.html
```

The command prints the public URL. New HTML pages can be published without an account; anonymous pages remain public for one hour and are deleted after 30 days.

Other file types are published as files and require a token:

```sh
npx schaffa upload ./diagram.png --token "sfa_…"
```

## Use a token

A token is required for permanent HTML pages, file uploads, and updates to an existing page.

```sh
# Automatically read from the environment
export SCHAFFA_TOKEN="sfa_…"
npx schaffa upload ./plan.html

# Or pass it directly
npx schaffa upload ./plan.html --token "sfa_…"
```

`--token` takes precedence when both methods are used. Command-line arguments may be retained in shell history, so prefer `SCHAFFA_TOKEN` when that is a concern.

To update a permanent HTML page, reuse its slug. Each update creates a new immutable version:

```sh
npx schaffa upload ./plan.html --slug abc234def567
```

Add `--json` to print the complete API response instead of only the public URL.

## Get a token

1. Sign in at [schaffa.dev/account](https://schaffa.dev/account).
2. Open the token section and create an upload token.
3. Copy the token when it is shown. Schaffa displays it only once.
4. Store it in your secret manager or export it as `SCHAFFA_TOKEN`.

Treat tokens like passwords. Do not commit them to Git or include them in published pages. If a token is exposed, revoke it in your account and create a replacement.
