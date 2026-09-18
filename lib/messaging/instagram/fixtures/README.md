# Recorded Instagram webhook payloads

Real deliveries from Meta to `POST /api/webhooks/instagram` (Instagram Login path), captured on 2026-09-17 for TAC-458. They were logged by the `INSTAGRAM_LOG_RAW_INBOUND` capture before TAC-458 removed it, then copied out of the Vercel runtime logs by a script. Nothing was retyped by hand.

| File | What it is |
|---|---|
| `message.json` | A guest's DM to the venue |
| `echo.json` | A reply typed by hand in the Instagram app, on the venue's account |
| `read.json` | The guest's read receipt for that reply |
| `postback-referral.json` | The guest tapping an icebreaker after opening an `ig.me` link carrying `?ref=TESTVENUE` |

## What was changed, and what wasn't

The repo is public, so identifiers and message text were replaced (ruled on TAC-458, 2026-09-17). Everything else is byte-for-byte what the route logged, which here is what Meta sent, because nothing outside the replaced fields needed escaping: key order, spacing, timestamps and the absence of a trailing newline. Each file is exactly as long as the body it was made from, and each replaced value is exactly as long as the original.

- **Venue account ID** → `17841400000000001`. It stays 17 digits.
- **Guest IGSID** → `1000000000000001`. It stays 16 digits, the length it had when captured.
- **Every `mid`** was rebuilt with made-up IDs, at the same length and format, and it still decodes the same way (see below). The echo and the read share one `mid`, as they did in the capture. What is kept from the real `mid`s: the fixed 34-character header, the `ZDZD` padding, and the leading digits of the thread ID (`3402823668`) and of each message ID (`33014212`, and `33014238` in the postback). Those keep the IDs in the ranges Meta uses; thread IDs sit just below 2^128, and a message ID's high digits appear to follow send time (an inference from three samples, not established), which the timestamps give anyway.
- **Message text** → `MSGTEXT` and `ECHO`, the same lengths as the originals.
- **Not replaced in the postback:** the referral's `source` and `type`, which are the finding, and its `ref`, which arrived as `TESTVENUE` because the link carried that value. Its `title` and `payload` aren't replaced either (confirmed by Jaipal, 2026-09-17): they are the venue's icebreaker configuration, not guest data, even though the thread shows the title as the guest's sent message, and `ICEBREAKER_HOURS` is what a handler branches on. They are safe here only because they are generic. A venue's icebreakers are visible to anyone who opens a DM with it, so a distinctive one would identify the venue even with every ID replaced; replace it in a future capture.

**Never commit a delivery's signature alongside its body.** A signature is valid for its body for as long as the app secret is unchanged, so a body plus its signature can be replayed as a genuine delivery. These files hold bodies only, and no signature is valid for them anyway: they differ from the bodies Meta signed. The app secret is also rotated before TAC-458 merges.

## What they show

`fixtures.test.ts` asserts each of these, so a re-capture that contradicts one fails a test.

- **Replies typed by hand in the Instagram app arrive as echoes.** They come on the `messages` field with `"is_echo": true` inside `message`. `sender` is the venue account and `recipient` is the guest, the reverse of an inbound message. A handler will therefore see messages venue staff send by hand. `is_echo` tells the venue's side from the guest's without inferring direction from sender and recipient, but it does not tell staff from the agent: replies the agent sends through the API most likely arrive as echoes too. That hasn't been captured yet; verify it when the real handler lands, so the handler neither answers its own messages nor mistakes them for a staff takeover.
- **A read receipt's payload key is `read`.** `messaging_seen` is only the name of the webhook subscription field. A receipt names one message by its `mid`, so read state is per message, not per thread. The captured receipt points at the staff reply in `echo.json`.
- **IDs are digit strings, and the two kinds differ in length.** The account ID is 17 digits. Both guest IGSIDs seen on 2026-09-17 were 16: the one in these fixtures, and a second guest's, from an earlier postback capture (20:02, a different account) that aged out of the logs. So a validator for one kind must not be reused for the other. Two samples don't show that every IGSID is 16 digits, and the test only requires digits.
- **An icebreaker tap after an `ig.me` link arrives as a postback carrying the referral.** The `ref` from the link arrived unchanged in the one sample (an uppercase alphanumeric value; how other characters fare isn't shown), with `source: "SHORTLINK"` and `type: "OPEN_THREAD"`. The `mid` is inside `postback`, just as it is inside `message` on a message. A hand transcription of this payload put `mid` beside `postback`, and the logged body showed that was wrong, which is why these files are copied by script and never transcribed.
- **In this capture, a thread the guest deleted on their side and reopened got a referral but kept its thread ID.** Jaipal deleted the thread from the guest side, in the Instagram app on the sending account, then reopened it through the link before this capture; the payload itself can't show the deletion. The referral fired as it does on a new thread, and the thread ID inside its `mid` is the one the earlier messages carry. That is expected, not surprising: Instagram's delete removes a chat only for whoever deleted it, so the venue still had the thread. On this path, an icebreaker tap into a chat that was empty again, a handler can't use a new thread ID to spot the guest coming back; the referral is the signal. Other ways back in weren't captured: following the link into a chat that still has messages shows no icebreakers, and a guest who types instead of tapping may or may not bring the referral.
- **A `mid` is not an opaque random token.** After a fixed 34-character header, it is base64 (with its `==` padding written as `ZDZD`) that decodes to `:<account id>:<thread id>:<item id>`. The thread ID (39 digits) is shared by every message in a conversation, and the item ID (35 digits) is per message. That's why the `mid`s had to be replaced along with the plain IDs.
- **The route's shape log can't tell an echo from a guest message.** Both summarize as `types: ['message']`, because `is_echo` is inside `message` and the summary records only the item's keys. A postback summarizes as `types: ['postback']`.
