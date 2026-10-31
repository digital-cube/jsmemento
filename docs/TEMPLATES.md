# Templates & Lookups (Phase 2)

Events are machine records (`USER_LOGIN` on `user/42` by `igor`); people read text. Memento
turns every event into a `rendered` sentence with a **Handlebars** template chosen per
tenant and per locale, and keeps the vocabulary of event / instance / actor types in a
**lookup** file that is validated, translated and turned into TypeScript types.

## 1. Rendering

### When it happens

| moment | what is rendered | where it goes |
|---|---|---|
| `POST /memento/events[?locale=sr]` | the new event, in `?locale` or `MEMENTO_DEFAULT_LOCALE` (`en`) | stored in `memento_event.rendered`, its locale in `rendered_locale`; published to Redis with it |
| `GET /memento/events?locale=sr` (also `POST /events/query` with `"locale"` in the body, and `GET /entities/:type/:id/events?locale=`) | events whose stored text is in another locale, or that have no text (stored before Phase 2) | the response only — rows are immutable and never updated |

Rules:

- **Producer text wins.** A `rendered` sent by the producer is stored verbatim with
  `rendered_locale: null` and is never re-rendered or translated.
- **`NOTE` is free text.** Its text is `payload.text` (required unless `rendered` is sent),
  stored verbatim with `rendered_locale: null`. No template, no translation.
- **Snapshot at push.** When the stored text is already in the requested locale it is returned
  as stored, even if the tenant changed its template since. Other locales use the current
  templates.

### Where the template comes from

For an event of type `T` requested in locale `L`, the locale chain is `L`, its parents, then
the default locale: `sr-Latn-RS → sr-Latn → sr → en`. Memento tries, in order:

```
T.<each locale of the chain>          tenant template (memento_template)  → bundled template
_generic.<each locale of the chain>   tenant template                     → bundled template
built-in "{{event_type}}: {{instance_type}}/{{instance_id}}"
```

So for `?locale=sr`: `T.sr` → `T.en` → `_generic.sr` → `_generic.en` (the ticket's chain), and at
**every** step a tenant's own template beats the bundled one. Locale beats source: a tenant
that customised only `USER_LOGIN.en` still gets the bundled Serbian `USER_LOGIN.sr` for `sr`
readers, not its English text.

A template that fails at render time (a helper called wrongly) is logged as a warning and
the built-in format is used: rendering never fails a push or a query.

### Bundled templates

`packages/server/templates/<EVENT_TYPE>.<locale>.hbs`, in `en` and `sr`:

| event type | payload fields used (all optional) | en example |
|---|---|---|
| `USER_LOGIN` | `ip` | `User igor logged in from 10.0.0.1.` |
| `USER_LOGOUT` | — | `User igor logged out.` |
| `USER_CREATED` | `name`, `username` | `igor created user Marko.` |
| `TICKET_CREATED` | `title` | `igor created ticket T-7: "Login broken".` |
| `TICKET_MODIFIED` | `changes` (list of fields, or object keyed by field) | `igor modified ticket T-7 (changed: title, status).` |
| `TICKET_CLOSED` | `resolution` | `Ticket T-7 was closed (resolution: fixed).` |
| `CHAT_MESSAGE_SENT` | `sender_user_id` (else `actor_id`), `content` (cut at 200 chars) | `igor sent a message: "Pozdrav!"` |
| `CHAT_MESSAGE_SEEN` | `user_id` (else `actor_id`) | `marko read the messages` |
| `CHAT_PARTICIPANT_ADDED` | `user_id` | `ana was added to the chat` |
| `_generic` | — (uses the lookup labels) | `Ticket closed: ticket T-7 (by igor).` |
| `NOTE` | `text` (required) | verbatim |

Templates use `actor_id` when present and fall back to an impersonal sentence
(`Kreiran je tiket T-7.`) when it is not.

### Writing a template

Context (plain JSON):

| name | value |
|---|---|
| `event_type`, `instance_type`, `instance_id`, `actor_id`, `occurred_at` | the event's fields |
| `payload` | the event's payload |
| `event` | all of the above as one object (`event.payload.x`) |
| `@locale` | the locale being rendered |

Helpers (the only functions a template can call):

| helper | example | result |
|---|---|---|
| `default a b …` | `{{default actor_id instance_id}}` | first non-empty value |
| `eq`, `ne`, `and`, `or`, `not` | `{{#if (eq payload.status "done")}}…{{/if}}` | booleans for `#if` |
| `upper`, `lower`, `capitalize` | `{{upper actor_id}}` | locale-aware case |
| `truncate s n` | `{{truncate payload.content 80}}` | cut at `n` chars + `…` |
| `join v sep` | `{{join payload.changes ", "}}` | list items, or the keys of an object |
| `json v` | `{{json payload}}` | JSON text |
| `date v [style] [timeZone=]` | `{{date occurred_at "short" timeZone="Europe/Belgrade"}}` | `Intl.DateTimeFormat` in the render locale (UTC by default) |
| `number v` | `{{number payload.amount}}` | `1.234,5` in `sr`/`de` |
| `plural n one= few= other=` | `{{plural payload.count one="# poruka" few="# poruke" other="# poruka"}}` | form picked by the locale's plural rules; `#` → the number |
| `label section value` | `{{label "EventTypes" event_type}}` | translated label from `i18n/translations.csv`, else the value |

Plus Handlebars' built-in `if`, `unless`, `each`, `with`, `lookup`.

**Sandbox.** Each server has an isolated Handlebars environment with only the helpers above.
Templates are checked when they are saved: unknown helpers, partials (`{{> x}}`) and
decorators are rejected (`422`), as are syntax errors. At render time the data is a JSON copy
of the event (functions cannot reach a template), prototype properties are not accessible
(`{{payload.constructor}}` renders empty), and the output is capped at 10 000 characters.

**Plain text.** Output is not HTML-escaped (`"` stays `"`). A UI that puts `rendered` into
HTML must escape it, like any other user-supplied text.

### Managing tenant templates (CLI)

```bash
pnpm memento create-template --tenant acme --event-type USER_LOGIN --locale en \
  --body '{{upper actor_id}} signed in to Acme'
pnpm memento create-template --tenant acme --event-type _generic --locale sr --file generic.sr.hbs
pnpm memento create-template --tenant acme --event-type USER_LOGIN --locale en --body '…' --replace
pnpm memento list-templates --tenant acme
pnpm memento delete-template --tenant acme --event-type USER_LOGIN --locale en
```

`create-template` refuses to overwrite an existing template for the same event type and locale
unless `--replace` is passed. Library users call `saveTemplate` / `listTemplates` /
`deleteTemplate` from `@memento/server`.

## 2. Lookups

### Files

```
lookups.yaml                       vocabulary (EventTypes, InstanceTypes, ActorTypes)
i18n/translations.csv              labels per locale: section,term,en,sr
var/candidates/<Section>.yaml      unknown values seen at ingestion (written by the server)
var/candidates/translations_candidate.csv   rows ready to paste into translations.csv
packages/core/src/lookups.generated.ts      TypeScript enums + Zod schemas (codegen)
```

Terms are `UPPER_SNAKE_CASE`. On the wire, event types are sent as written (`USER_LOGIN`),
instance and actor types in lower case (`USER` → `"user"`). The actor type is read from
`payload.actor_type`.

### At runtime

The server loads `lookups.yaml` and `i18n/translations.csv` at startup (`MEMENTO_LOOKUPS_PATH`,
`MEMENTO_TRANSLATIONS_PATH`). An invalid YAML or a translations sheet with errors stops the
start; a missing `lookups.yaml` disables lookups with a warning.

On every push:

- **default**: unknown `event_type` / `instance_type` / `payload.actor_type` values are
  accepted and recorded as candidates — `count`, `first_seen`, `last_seen` per value in
  `var/candidates/<Section>.yaml`, and one row per new value in
  `translations_candidate.csv`. Recording is best effort: an IO error is logged, the push
  succeeds. `MEMENTO_RECORD_CANDIDATES=false` turns it off; `MEMENTO_CANDIDATES_DIR` moves it.
- **strict** (`MEMENTO_LOOKUPS_STRICT=true`): such events are rejected with `422
  validation_error`, `details: [{ section, value, message }]`.

### CSV for spreadsheets

`i18n/translations.csv` can be edited in Excel / LibreOffice / Google Sheets. The reader
accepts a UTF-8 BOM, CRLF, `,`, `;` or tab as delimiter (detected from the header), quoted
cells with `""` and line breaks, and rows whose trailing empty cells were dropped.

Validation (`pnpm memento lookups validate`) reports `file:line [column]`:

- **errors** (sheet unusable, server will not start): header not `section,term,<locale>…`,
  invalid or duplicate locale column, unknown section, unknown term, duplicate row, more
  cells than the header.
- **warnings**: an empty translation cell, a term with no row.

### Promoting a candidate

1. `pnpm memento lookups candidates`: see what producers send that the vocabulary lacks.
2. Add the term to `lookups.yaml`, and its row (from `translations_candidate.csv`) to
   `i18n/translations.csv` with real labels.
3. `pnpm memento lookups validate`.
4. `pnpm memento lookups codegen`: regenerates `packages/core/src/lookups.generated.ts`.
   A test (and `pnpm memento lookups codegen --check`) fails when it is out of date.
5. Optionally add `packages/server/templates/<TERM>.en.hbs` / `.sr.hbs`.

### Typed lookups

```ts
import { EventType, EVENT_TYPES, KnownEventTypeSchema, InstanceType } from "@memento/core";

EventType.USER_LOGIN;                 // "USER_LOGIN"
InstanceType.USER;                    // "user"
KnownEventTypeSchema.parse("NOTE");   // z.enum(EVENT_TYPES): throws for unknown types
```

The open `EventTypeSchema` (any `SCREAMING_SNAKE_CASE`) stays the push contract. The `Known…`
schemas are for clients that want to restrict themselves to the vocabulary.

## 3. Configuration

| variable | default | |
|---|---|---|
| `MEMENTO_DEFAULT_LOCALE` | `en` | locale used when a request names none; last step of every chain |
| `MEMENTO_LOOKUPS_PATH` | `<repo>/lookups.yaml` | |
| `MEMENTO_TRANSLATIONS_PATH` | `<dir of lookups.yaml>/i18n/translations.csv` | optional file |
| `MEMENTO_CANDIDATES_DIR` | `<dir of lookups.yaml>/var/candidates` | |
| `MEMENTO_RECORD_CANDIDATES` | `true` | `false` / `0` / `no` disables recording |
| `MEMENTO_LOOKUPS_STRICT` | `false` | reject unknown values instead of recording them |
