// Copy to include/config.h (gitignored) and fill in. 2.4 GHz WiFi only.
#pragma once

#define WIFI_SSID "venue-wifi"
#define WIFI_PASSWORD "change-me"

// Guest host serving /api/devices/*. Confirm against the deployed route.
#define API_HOST "webhooks.theanalog.company"
#define DEVICE_ID "replace-with-pos_devices.device_id"
// Plain device token; the server stores only its sha256 (pos_devices.device_token_hash).
#define DEVICE_TOKEN "replace-with-device-token"

// The MUNBYN P047: static IP or DHCP reservation, raw ESC/POS on TCP 9100.
#define PRINTER_IP "192.168.1.50"
#define PRINTER_PORT 9100

#define POLL_INTERVAL_MS 3000
// QR module size in dots, 1-16. 8 reads well on 80 mm paper.
#define QR_MODULE_SIZE 8
