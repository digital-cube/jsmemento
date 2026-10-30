# JSMemento Philosophy & Core Concepts

## Memento = Immutable Ledger (like blockchain)

Memento je inspired by blockchain principles:
- **Everything that happens is recorded forever** — nema brišanja, samo soft-delete (arhiviranje)
- **Tamper-proof audit trail** — eventi se ne menjaju, samo čitaju
- **Traceability** — svaki događaj je vezan za konkretnu instancu (konkretan tiket, korisnika, event)

> *"Every event deserves to be remembered."*

---

## Core Abstraction: Instance (instance_type + instance_id)

Sve što se desi je vezano za **instancu** — konkretan poslovni objekat:

| Instance | Primjer |
|----------|---------|
| `user/42` | Korisnik sa ID-om 42 |
| `ticket/T-777` | Tiket sa ID-om T-777 |
| `invoice/INV-2026-001` | Faktura sa konkretnim brojem |
| `chat/chat-acme-sales-2026-10` | Chat između dva korisnika (ili u sobi) |
| `room/room-sales-team` | Opšta soba / kanal |

**Ključna pitanja:**
- *"Šta se dešavalo sa korisnikom X?"* → `GET /events?instance_type=user&instance_id=X`
- *"Šta se dešavalo sa tiketom Y?"* → `GET /events?instance_type=ticket&instance_id=Y`
- *"Svi eventi u sobi Z?"* → `GET /events?instance_type=room&instance_id=Z`

---

## Chats as First-Class Memento Events

Originalno je Memento zamišljen kao **activity log** (USER_LOGIN, TICKET_MODIFIED, itd.).

**Novo otkriće:** Chat poruke su takođe Memento događaji:

```
Chat između Igora i Marija (instance: chat/igor-marko-2026-10)
├── 2026-10-30T10:00:00Z — EVENT: "CHAT_MESSAGE_SENT"
│   └── payload: { sender: "igor", content: "Pozdrav!", ... }
├── 2026-10-30T10:05:00Z — EVENT: "CHAT_MESSAGE_SENT"
│   └── payload: { sender: "marko", content: "Evo!", ... }
└── 2026-10-30T10:10:00Z — EVENT: "CHAT_MESSAGE_SEEN"
    └── payload: { user: "marko", ... }
```

**Primena:**
1. **Activity feed per chat** — history poruka (kao Discord/Slack history)
2. **Seen/unseen tracking** — koga je pročitao
3. **Star/bookmark** — važne poruke
4. **Real-time streaming** — WebSocket `/ws?instance_type=chat&instance_id=...`
5. **Search** — "kada je Igor poslao poruku sa reči 'deadline'?"

---

## Search & Filtering: Narrow Down by Instance

Pretraga mogu biti sužena na različitim nivoima:

```
// Sve što se dešavalo u sistemu
GET /events

// Sve što se dešavalo sa userniku 42
GET /events?instance_type=user&instance_id=42

// Sve poruke u čatu između Igora i Marka
GET /events?instance_type=chat&instance_id=igor-marko-2026-10&event_type=CHAT_MESSAGE_*

// Sve CHAT_MESSAGE_SENT (svi čatovi, svi korisnici)
GET /events?event_type=CHAT_MESSAGE_SENT

// Familie instanci (npr. svi čatovi jednog korisnika)
GET /events?instance_type=chat&instance_id=igor-*
```

**Advanced:** Kombinovane pretrage
```
// Sve što se dešavalo sa tiketom T-777, nakon što je Igor bio dodat
GET /events?instance_type=ticket&instance_id=T-777&after=2026-10-20T00:00:00Z&actor_id=igor
```

---

## Message Structure: Translation-Friendly

Svi eventi su strukturirani za lakšu **lokalizaciju** — poruke se mogu automatski prevesti:

```json
{
  "event_type": "CHAT_MESSAGE_SENT",
  "instance_type": "chat",
  "instance_id": "igor-marko-2026-10",
  "actor_id": "igor",
  "payload": {
    "content": "Pozdrav!",
    "timestamp": "2026-10-30T10:00:00Z"
  },
  "rendered": "Igor je poslao poruku: \"Pozdrav!\""
}
```

**Šablon za rendering:**
```jinja2
{# templates/CHAT_MESSAGE_SENT.j2 #}
{{ event.actor_id }} je poslao poruku: "{{ payload.content }}"
```

**Translation:**
```csv
event_type,locale,template
CHAT_MESSAGE_SENT,en,"{{ actor_id }} sent a message: \"{{ payload.content }}\""
CHAT_MESSAGE_SENT,sr,"{{ actor_id }} je poslao poruku: \"{{ payload.content }}\""
CHAT_MESSAGE_SENT,de,"{{ actor_id }} hat eine Nachricht gesendet: \"{{ payload.content }}\""
```

**ALI:** Samo strukturovani eventi se prevode (event_type + template).  
**NE:** Free-text poruke (USER_WRITTEN_NOTE) se NE prevode (to bi trebalo manualno od korisnika).

---

## Use Cases

### 1. Activity Log (klasični memento)
```
Šta se dešavalo sa korisnikom?
- USER_LOGIN
- TICKET_CREATED
- TICKET_MODIFIED
- INVOICE_PAID
- PERMISSION_GRANTED
```

### 2. Chat History (novo)
```
Šta se dešavalo u čatu?
- CHAT_MESSAGE_SENT
- CHAT_MESSAGE_SEEN
- CHAT_PARTICIPANT_ADDED
- CHAT_PARTICIPANT_LEFT
```

### 3. Audit Trail (compliance)
```
Ko je šta uradio i kada?
- INVOICE_CREATED (actor_id: igor, payload: invoice_id)
- INVOICE_MODIFIED (actor_id: marko, payload: changes)
- INVOICE_DELETED (actor_id: admin, reason: fraud)
```

### 4. Feed (chronological)
```
Sve što se dešavalo (filtrabilno):
- User feed (samo moji eventi)
- Team feed (svi eventi u mom timu)
- Global feed (svi eventi — sa admin ključem)
```

---

## Architecture Impact for jsmemento

Ova filosofija ima implikacije za v1.0:

1. **Instance model je centralan** — svi eventi su vezani za instancu
2. **Chat podrška** — nije u v1.0, ali arhitektura mora da je dozvoli u v1.1+
3. **Search/filter** — trebaju biti fleksibilni (ne samo event_type, nego i instance_type, instance_id, actor_id, time range, itd.)
4. **Rendering** — template engine mora da podržava translation (locale fallback)
5. **Real-time** — WebSocket stream mora da filtrira po instance-i
6. **Imutabilnost** — ključna garantija — nema edit-a, samo soft delete

---

## Sljedeća pitanja za TCKP3JCT29

Dodam ova pitanja ako trebaju odgovori:

**#11: Should Chat be "first-class" in v1.0 scope, or defer to v1.1?**
- [ ] Full chat support in v1.0 (CHAT_MESSAGE_SENT, CHAT_MESSAGE_SEEN, itd.)
- [ ] Activity log only in v1.0, defer chat to v1.1
- [ ] Prepare architecture for chat (v1.0), implement endpoints in v1.1

**#12: Search complexity — phased approach?**
- [ ] v1.0: Basic filters (instance_type, instance_id, event_type)
- [ ] v1.1: Advanced (actor_id, time range, full-text search via OpenSearch)

**#13: Free-text message handling?**
- [ ] v1.0: No free-text (nur strukturovani eventi sa template rendering)
- [ ] v1.0: Support both (strukturovani + free-text notes)

---

*Verzija: 2026-10-30*  
*Dodan kontekst iz brainstorm sesije tokom EPCXWNE2*
