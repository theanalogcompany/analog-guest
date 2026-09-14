// TAC-327 KEEP: "do not ask the guest to do anything in return" (below) is
// pursuit-shaped but structurally INERT today, not a leak — welcome is
// outbound-only (dropped from the classifier's inbound enum since
// TAC-238/migration 016) and intentions render on INBOUND runs only
// (build-runtime-context.ts), so welcome and a non-empty intentions block
// cannot co-occur. TAC-380 removed the created_via='qr_scan' origin gate this
// note originally leaned on; the inbound-only gate is what holds now. INERT BY
// GATE COINCIDENCE, NOT BY PERMANENT DESIGN: intentions rendering on an
// outbound path would break it. Re-verify before assuming this stays inert.
export const WELCOME_INSTRUCTIONS = `This is the first message the venue is sending to a new guest. Treat it like the venue saying hi. Warm, low-pressure. Do not pitch anything, do not list benefits, and do not ask the guest to do anything in return. If the guest's name is provided, you may use it once, naturally. The goal is to feel like a door has opened, not like an onboarding email.`
