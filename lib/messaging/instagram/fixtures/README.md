# Recorded Instagram webhook payloads

Real deliveries from Meta to `POST /api/webhooks/instagram` (Instagram Login path), captured on 2026-09-17 for TAC-458. They were logged by the `INSTAGRAM_LOG_RAW_INBOUND` capture before TAC-458 removed it, then copied out of the Vercel runtime logs by a script. Nothing was retyped by hand.

| File | What it is |
|---|---|
| `message.json` | A guest's DM to the venue |
| `echo.json` | A reply typed by hand in the Instagram app, on the venue's account |
| `read.json` | The guest's read receipt for that reply |

A postback with a referral attached (the icebreaker tap after opening an `ig.me` link) is not recorded here yet. See the note at the end.

## What was changed, and what wasn't

The repo is public, so identifiers and message text were replaced (ruled on TAC-458, 2026-09-17). Everything else is byte-for-byte what Meta sent: key order, spacing, timestamps and the absence of a trailing newline. Each file is exactly as long as the body it was made from.

- **Venue account ID** → `17841400000000001`. It stays 17 digits.
- **Guest IGSID** → `1000000000000001`. It stays 16 digits, the length it had when captured.
- **Every `mid`** was rebuilt with made-up IDs. It is the same length and format, and it still decodes the same way (see below). The echo and the read share one `mid`, as they did in the capture.
- **Message text** → `MSGTEXT` and `ECHO`, the same lengths as the originals.

**Never commit a delivery's signature alongside its body.** A signature is valid for its body for as long as the app secret is unchanged, so a body plus its signature can be replayed as a genuine delivery. These files hold bodies only. The captures were also made before the app secret was rotated (TAC-458).

## What they show

`fixtures.test.ts` asserts each of these, so a re-capture that contradicts one fails a test.

- **Replies typed by hand in the Instagram app arrive as echoes.** They come on the `messages` field with `"is_echo": true` inside `message`. `sender` is the venue account and `recipient` is the guest, the reverse of an inbound message. A handler will therefore see messages venue staff send by hand, and can tell them apart by `is_echo` without inferring direction from sender and recipient.
- **A read receipt's payload key is `read`.** `messaging_seen` is only the name of the webhook subscription field. A receipt names one message by its `mid`, so read state is per message, not per thread. The captured receipt points at the staff reply in `echo.json`.
- **IDs are digit strings of varying length.** The account ID is 17 digits, and both guest IGSIDs seen were 16. A validator must not assume a single length.
- **A `mid` is not an opaque random token.** After a fixed prefix, it base64-decodes to `:<account id>:<thread id>:<item id>`. The thread ID (39 digits) is shared by every message in a conversation, and the item ID is per message. That's why the `mid`s had to be replaced along with the plain IDs.
- **The route's shape log can't tell an echo from a guest message.** Both summarize as `types: ['message']`, because `is_echo` is inside `message` and the summary records only the item's keys.

## Postback with referral: not yet recorded

The capture of this delivery aged out of the Vercel runtime logs before it could be copied. A hand transcription of it exists on TAC-458, but it places `mid` beside `postback` rather than inside it, which contradicts Meta's documentation and can't be checked against the original. It isn't committed here, because a fixture that gets that detail wrong would be silently wrong for as long as it exists.
