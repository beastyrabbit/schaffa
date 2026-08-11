# Schaffa CLI

Schaffa is the workhorse that connects an AI agent's output to the web. The name comes from the Swabian word for working and getting things done.

## Usage

New HTML pages can be uploaded anonymously and remain public for one hour:

```sh
npx --registry=https://git.heerlab.com/api/packages/beasty/npm/ schaffa@0.1.1 upload ./plan.html
```

Anonymous pages disappear after one hour and are deleted after 30 days. Keep a bearer token in the environment for permanent pages, files, and page updates:

```sh
export SCHAFFA_TOKEN="sfa_…"
npx schaffa upload ./plan.html
```

You can also provide the token directly:

```sh
npx schaffa upload ./plan.html --token "sfa_…"
```

Command-line arguments may be retained in shell history. Use `SCHAFFA_TOKEN` when that is a concern. The CLI always connects to `https://schaffa.dev` unless `SCHAFFA_URL` is set.

HTML files create a page with a random slug. With a token, reuse a slug to publish the next immutable version:

```sh
npx schaffa upload ./plan.html --slug abc234def567
```

Other file types are published as files:

```sh
npx schaffa upload ./diagram.png
```

Add `--json` to print the complete JSON response instead of only the public URL.
