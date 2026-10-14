# Passport stamp spec (Figma "Passport — final", sections 05 and 08)

Section 08 (TAC-587) adds the time to every stamp and `VISITED` to VISIT. Its drawing has no ★ only because its font lacks the glyph; the stars below stay.

Each stamp is a transparent PNG with no paper, background or shadow, tilted a few degrees (between −8° and +8°).

## Style
A real rubber stamp pressed by hand. One flat ink colour per stamp. Weathered but fully readable:
- slightly rough, broken edges;
- fine speckled gaps where the ink didn't take;
- ink a little heavier on one side and lighter on the other (roughly 75–100% density).

No blur, no glow, no 3D, no illustrations or icons. Text and simple lines only; small stars (★) are allowed as ornaments.

## Type
- Everything uppercase.
- Titles in Oswald SemiBold; small labels in Oswald Medium, widely letter-spaced.
- Dates in Courier Prime Bold, written as `30 OCT 2026`.
- Times in Courier Prime Bold, written as `1:22 PM`: 12-hour clock, no leading zero.

## Fill-ins
- [VENUE] = the venue's full name, uppercase, from venue settings. For Le Mil's: `LE MIL'S COFFEE`. Use it everywhere: stamps and page headers.
- [CITY] = `S.F.` (ARRIVED) / `SAN FRANCISCO` (VISIT)
- [DATE] = the transaction date in the venue's timezone
- [TIME] = the transaction time in the venue's timezone, from the same instant as [DATE]
- [ITEM] = the menu item
- [PERK] = a vague perk name

## Native sizes (1x, drawn at 2x)

| Kind | Size | Ink |
|---|---|---|
| ARRIVED | 250 × 156 | `#A85638` |
| VISIT | 150 × 150 | `#1C1814` |
| DISCOVERED | 240 × 118 | `#7C8C63` |
| INVITED | 210 × 150 | `#5C3F26` |

## Stamp types

### ARRIVED (oval, about 1.6 : 1)
- Thick outer oval (3.4) and a thin dashed inner oval (1.2, dash 5/4), inset 10/9.
- `ARRIVED`: Oswald SemiBold 34, letter-spacing 6%, centred at y=50.
- Two rules (1.6) at y=74 and y=104, x 40→210.
- `[DATE] · [TIME]`: Courier Prime Bold 13 at y=89, shrunk to fit within 160 wide, with a ★ (Oswald Medium 10) at x=26 and x=224.
- `[VENUE] · [CITY]`: Oswald Medium 10, letter-spacing 14%, at y=122.

### VISIT (circle)
- Thick outer ring (3) and a thin inner ring (1.1), inset 9.
- `VISITED`: Oswald SemiBold 9, letter-spacing 45%, at y=29.
- [VENUE]: Oswald SemiBold 15, letter-spacing 3%, centred at y=45. Shrink the size until it is at most 104 wide.
- Rules (1.4) at y=58 and y=93, x 26→124.
- [DATE]: Courier Prime Bold 14 at y=70.
- [TIME]: Courier Prime Bold 10.5 at y=83, on its own line.
- `SAN FRANCISCO`: Oswald Medium 8, letter-spacing 14%, at y=106.
- ★ (Oswald Medium 9) at y=121.
- Anniversary variant (out of scope for TAC-586): dotted inner ring, small `A YEAR OF` above [VENUE], `★ ★ ★` under the date.

### DISCOVERED (rectangle, about 2 : 1)
- Outer border (3) with corner radius 6; inner border (1.2) inset 7 with corner radius 3.
- `DISCOVERED`: Oswald SemiBold 13, letter-spacing 40%, at y=25.
- Rules (1.4) at y=39 and y=82, x 30→210.
- [ITEM]: Oswald SemiBold 26 at y=61, letter-spacing 3%. Use 21 when the item is longer than 12 characters, and shrink further to fit within 200 wide.
- `[DATE] · [TIME] · [VENUE]`: Courier Prime Bold 10.5 at y=97, shrunk to fit within 212 wide.

### INVITED (box, about 1.4 : 1)
- Outer border (2.8) with corner radius 3.
- A solid ink band across the top, 32 high, with `INVITED` knocked out of it (Oswald SemiBold 15, letter-spacing 50%, centred at y=16) so the paper shows through the letters.
- `BY THE HOUSE`: Oswald SemiBold 25, letter-spacing 5%, at y=63.
- [PERK]: Oswald Medium 11, letter-spacing 26%, at y=92 (e.g. `OFF MENU`, `THE BACK BAR`).
- Rule (1.3) at y=107, x 20→190.
- `[DATE] · [TIME] · [VENUE]`: Courier Prime Bold 10.5 at y=127, shrunk to fit within 186 wide.

All y values are text centres, in 1x units from the top of the stamp.

## Wear
- Multiply the stamp's alpha by a seeded crop and rotation of `worn-ink-texture.png` (seamless, 1024×1024, 8-bit greyscale; white keeps ink, black is a gap).
- Then apply a linear pressure fade from 100% down to 74–82% at a seeded angle.

## Rules
- Spell every word exactly as given.
- The date and time are the only numbers on a stamp; never show counts.
- Keep these proportions so each type is recognisable by shape alone.
