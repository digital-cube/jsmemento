# `memento` CLI (Phase 5)

```bash
pnpm memento --help                 # every command, examples, environment
pnpm memento <command> --help       # options and examples of one command
```

The admin commands talk to PostgreSQL directly (`DATABASE_URL`). `tail` talks to a running
server (`MEMENTO_URL`, `MEMENTO_API_KEY`). Add `--json` before the command for
machine-readable output.

| command | |
|---|---|
| `setup` | first run, step by step: migrate, create a tenant, create its first key (terminal only) |
| `migrate` | apply pending migrations |
| `create-tenant [slug] --name` | create a tenant |
| `list-tenants` | list tenants |
| `create-key --tenant --scopes --name [--expires-in-days]` | create an API key (printed once) |
| `revoke-key <prefix>` | revoke a key |
| `create-template` / `list-templates` / `delete-template` | per-tenant Handlebars templates ([TEMPLATES.md](TEMPLATES.md)) |
| `create-chat` / `send-message` | chats ([CHATS.md](CHATS.md)) |
| `tail` | print new events as they are stored, like `tail -f` |
| `lookups validate` / `codegen` / `candidates` | the vocabulary in `lookups.yaml` |

## In a terminal

When stdin and stdout are a terminal, the CLI changes how it behaves:
- **Colours:** green `✔` for success, red `error:`, a dim `hint:` line. `NO_COLOR=1` turns
  colours off.
- **Spinners** on slow steps (migrating, creating). They are drawn on stderr and never shown
  for `--json`.
- **Questions instead of usage errors:**
  - `memento create-tenant` with no slug asks for the slug (validated as you type) and the
    display name.
  - `memento create-key` with no flags lets you pick the tenant from a list, tick scopes
    (`read` is preselected) and name the key.
  - Any flag you pass is not asked again. Ctrl+C at a question exits with code 130.
  - In scripts and CI (no TTY) and with `--json`, nothing is asked: a missing option is the
    usual usage error.

```
$ pnpm memento setup
✔ database is up to date
? Tenant slug (lowercase letters, digits and dashes, e.g. acme) acme
? Display name Acme
✔ created tenant acme (Acme)
? Create an API key for it now? Yes
? Scopes read, write
? What is the key for? (e.g. backend-prod) local
✔ created key "local" for acme [read,write]
…
```

## `memento tail`

```bash
export MEMENTO_API_KEY=mk_…                       # a key with read
memento tail --chat-id chat-123                   # one chat's messages
#   [09:59:00] Marko: Ćao!
#   ● live: following chat-123 (Ctrl+C to stop)
#   [10:00:00] Igor: Pozdrav!
memento tail --event-type 'USER_*' -n 0           # only new user events, no history
#   [10:01:12] USER_LOGIN user/42 User igor logged in from 10.0.0.1.
memento --json tail --instance-type ticket | jq .rendered
```

- It first prints the last `-n` events (default 10), then follows the stream. Chat messages
  print as `[HH:MM:SS] sender: text`, other events as `[HH:MM:SS] TYPE instance story`.
- **Filters:**
  - `--chat-id` (= `instance_type=chat`, the chat's `instance_id`, `CHAT_MESSAGE_SENT`);
  - `--event-type`, `--instance-type`, `--instance-id`, `--actor`, where `prefix*` works too;
  - `--locale` re-renders the stories.
- **Server:** `--url` / `MEMENTO_URL`, default `http://localhost:8000/memento`. **Key:**
  `--api-key` / `MEMENTO_API_KEY`.
- **Connection notices** go to stderr (`● live …`, `○ offline: … reconnecting in 1s`), so
  stdout is only events. The connection comes back by itself; Ctrl+C stops.
- A wrong key or an unreachable server is reported before streaming starts. For example:
  `error: invalid or expired API key` with `hint: check --api-key / MEMENTO_API_KEY`.

## Errors

Errors are one line plus, when there is something to do, a hint. There are no stack traces:

```
error: cannot connect to PostgreSQL at localhost:5432/jsmemento
hint: start it with `pnpm db:up`, or point DATABASE_URL at a running server
```

| situation | message |
|---|---|
| PostgreSQL down / unknown host | `cannot connect to PostgreSQL at host:port/db` |
| wrong user or password | `PostgreSQL at … rejected the user or password` |
| database missing | `the database in DATABASE_URL (…) does not exist` |
| not migrated | `the database has no memento tables yet` → `run memento migrate first` |
| domain errors | the API's own message, e.g. `tenant "acme" already exists` |
| anything else | `unexpected failure: …` → `set MEMENTO_DEBUG=1 to see the stack trace` |

The password in `DATABASE_URL` is never printed. Exit codes:
- `0`: success;
- `1`: an error;
- `130`: cancelled at a question;
- otherwise Commander's own code for usage errors.
