// Host check: g++ -std=c++17 -I lib/escpos test/host/escpos_test.cpp && ./a.out
// The expected bytes are written out from the Epson ESC/POS QR command spec
// (GS ( k, function 165/167/169/180/181), independently of the builder.
#include <algorithm>
#include <cstdio>
#include <cstdlib>

#include "escpos.h"

static int failures = 0;
static void check(bool ok, const char *what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) failures++;
}

int main() {
  const std::string url = "https://ig.me/m/theanalog.company?ref=sc_abcDEF-_123";
  auto b = buildQrSlip(url, 8);

  const uint8_t head[] = {0x1b, 0x40, 0x1b, 0x61, 0x01,
                          0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
                          0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08,
                          0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31};
  check(b.size() > sizeof head && std::equal(head, head + sizeof head, b.begin()),
        "init, center, model 2, size 8, EC M");

  size_t i = sizeof head;
  uint16_t n = url.size() + 3;
  const uint8_t store[] = {0x1d, 0x28, 0x6b, (uint8_t)(n & 0xff), (uint8_t)(n >> 8),
                           0x31, 0x50, 0x30};
  check(std::equal(store, store + sizeof store, b.begin() + i), "store-data header, pL pH = len+3");
  i += sizeof store;
  check(std::string(b.begin() + i, b.begin() + i + url.size()) == url, "URL verbatim");
  i += url.size();
  const uint8_t tail[] = {0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
                          '\n', '\n', '\n', '\n', 0x1d, 0x56, 0x42, 0x03};
  check(b.size() == i + sizeof tail && std::equal(tail, tail + sizeof tail, b.begin() + i),
        "print-symbol, feed, partial cut, nothing after");

  // A URL long enough to carry a 2-byte length still encodes it correctly.
  std::string longUrl(300, 'x');
  auto c = buildQrSlip(longUrl, 8);
  uint16_t m = 303;
  check(c[sizeof head + 3] == (m & 0xff) && c[sizeof head + 4] == (m >> 8), "length > 255 uses pH");
  return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
