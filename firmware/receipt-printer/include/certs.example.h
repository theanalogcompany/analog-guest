// Copy to include/certs.h (gitignored). Paste the ROOT certificate of the
// chain API_HOST serves. See README "TLS". The firmware refuses to start
// without a root: it never falls back to unverified TLS.
#pragma once

static const char ROOT_CA_PEM[] = R"PEM(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)PEM";
