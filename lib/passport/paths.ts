// TAC-586: where a stamp's two images live in the `guest-media` bucket.
//
// COMPUTED FROM IDS, never read back from a column, for the reason
// lib/messaging/attachments/delete.ts gives: if the upload lands and the row
// update after it does not, the path is still known, so deletion can still
// find the file.

export type PassportImage = 'stamp' | 'spread'

export const PASSPORT_IMAGES: readonly PassportImage[] = ['stamp', 'spread']

export function passportImagePath(
  scope: { venueId: string; guestId: string; stampId: string },
  image: PassportImage,
): string {
  return `passport/${scope.venueId}/${scope.guestId}/${scope.stampId}/${image}.png`
}
