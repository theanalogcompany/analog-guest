# receipt-printer firmware

Lives in `analog-guest/firmware/receipt-printer/` (monorepo; the server half is
`app/api/devices/[deviceId]/print-jobs/route.ts`).

Firmware for a Seeed XIAO ESP32-C3 that bridges Analog scan-code print jobs to a
LAN receipt printer (MUNBYN P047, 80 mm, raw ESC/POS on TCP 9100).

```
Square -> analog-guest -> GET /api/devices/{id}/print-jobs
                                   ^ poll (HTTPS, bearer token)
                         XIAO ESP32-C3 --TCP :9100--> printer
```

The server owns the QR content. Each job carries a finished `ig.me` URL and the
firmware prints it verbatim. 2.4 GHz WiFi only.

## Server contract (analog-guest)

`GET https://<API_HOST>/api/devices/<DEVICE_ID>/print-jobs?since=<ISO>`
with `Authorization: Bearer <device token>`.

| status | body |
| --- | --- |
| 200 | `{ "cursor": "<ISO>"\|null, "jobs": [{ "id", "at": "<ISO>", "url" }] }`, oldest first, max 10 |
| 401 | `{ "error": "unauthorized" }` (missing token, unknown device, or bad token) |
| 500 | `{ "error": "internal_error" }` |

## Setup

1. **Printer.** Hold Feed while powering on for the self-test page (shows its IP). Give it a
   static IP or a DHCP reservation. Check from a laptop on the same WiFi:
   `printf 'hello\n\n\n' | nc <printer-ip> 9100`.
2. **Device row.** A `pos_devices` row for the venue with `sha256(token)` in
   `device_token_hash`.
3. **Config.** `cp include/config.example.h include/config.h` and fill it in.
4. **TLS.** `cp include/certs.example.h include/certs.h`, then paste the root CA of the chain the
   API host serves:
   `openssl s_client -showcerts -connect <API_HOST>:443 </dev/null`
   and take the last certificate in the chain (or the matching root from your OS trust store).
   There is deliberately no insecure fallback.
5. **Flash.** `pio run -t upload`, then `pio device monitor`.

## Behaviour

- First boot stores "now" as the cursor, so the venue's history is never reprinted.
- The cursor (flash) advances only after the whole slip is written to the printer. A printer that
  is off or unreachable means the job is retried every poll. A power cut mid-write can duplicate
  a slip, never lose one.
- A payment the server cannot issue a code or link for is withheld and holds back later ones.
- No paper-out detection yet: a write to a printer with no paper may count as printed.

## Status

The ESC/POS bytes are checked on a host: `g++ -std=c++17 -I lib/escpos test/host/escpos_test.cpp -o /tmp/escpos_test && /tmp/escpos_test`.
The Arduino side (`src/main.cpp`) has not been compiled or run on hardware. First thing to do:
`pio run`, then print one job against a real payment.
