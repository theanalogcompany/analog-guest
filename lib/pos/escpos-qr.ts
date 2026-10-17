// The ESC/POS slip a receipt printer renders a scan link as: centered QR, feed,
// partial cut. PURE, no imports. The same bytes as the firmware's
// `buildQrSlip` (firmware/receipt-printer/lib/escpos/escpos.h); both are
// checked against the Epson GS ( k QR command layout, so a change to one is a
// change to the other.
//
// The URL is printed verbatim and is built server-side (scan-link.ts): a
// device that assembled the link itself would be a second definition of it.

/** Module size in dots, 1-16. 8 reads well on 80 mm paper. */
export const DEFAULT_QR_MODULE_SIZE = 8

export function buildQrSlip(
  url: string,
  moduleSize: number = DEFAULT_QR_MODULE_SIZE,
): Buffer {
  const data = Buffer.from(url, 'utf8')
  const n = data.length + 3
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]), // init
    Buffer.from([0x1b, 0x61, 0x01]), // center
    Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // model 2
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]), // size
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // EC level M
    Buffer.from([0x1d, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30]), // store
    data,
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), // print
    Buffer.from('\n\n\n\n'),
    Buffer.from([0x1d, 0x56, 0x42, 0x03]), // feed + partial cut
  ])
}
