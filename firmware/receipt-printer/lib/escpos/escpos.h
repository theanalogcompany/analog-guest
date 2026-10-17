// ESC/POS slip builder. Pure C++ (no Arduino types) so it compiles on a host
// and test/host/escpos_test.cpp can check the bytes without hardware.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Centered QR (model 2, error correction M), feed, partial cut. A byte vector,
// not a C string: the command bytes contain 0x00.
inline std::vector<uint8_t> buildQrSlip(const std::string &url, uint8_t moduleSize) {
  std::vector<uint8_t> b;
  auto put = [&b](std::initializer_list<uint8_t> bytes) {
    b.insert(b.end(), bytes.begin(), bytes.end());
  };
  put({0x1b, '@'});     // init
  put({0x1b, 'a', 1});  // center
  put({0x1d, '(', 'k', 4, 0, '1', 'A', '2', 0});    // QR model 2
  put({0x1d, '(', 'k', 3, 0, '1', 'C', moduleSize});  // module size
  put({0x1d, '(', 'k', 3, 0, '1', 'E', '1'});       // error correction M
  uint16_t n = static_cast<uint16_t>(url.size() + 3);  // store data
  put({0x1d, '(', 'k', static_cast<uint8_t>(n & 0xff), static_cast<uint8_t>(n >> 8),
       '1', 'P', '0'});
  b.insert(b.end(), url.begin(), url.end());
  put({0x1d, '(', 'k', 3, 0, '1', 'Q', '0'});  // print stored symbol
  put({'\n', '\n', '\n', '\n'});
  put({0x1d, 'V', 'B', 3});  // feed + partial cut
  return b;
}
