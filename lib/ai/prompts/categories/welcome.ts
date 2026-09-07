// TAC-327 KEEP: "do not ask the guest to do anything in return" (below) is
// pursuit-shaped but structurally INERT today, not a leak — welcome is
// outbound-only (dropped from the classifier's inbound enum since
// TAC-238/migration 016) and intentions is gated to created_via='qr_scan'
// only, so welcome and a non-empty intentions block cannot co-occur on any
// current origin flow. INERT BY GATE COINCIDENCE, NOT BY PERMANENT DESIGN:
// TAC-324 frames intentions as a primitive expected to grow, and a future
// intention with an origin gate other than qr_scan-only would break this
// non-co-occurrence. Re-verify the gate logic before assuming this stays
// inert.
export const WELCOME_INSTRUCTIONS = `This is the first message the venue is sending to a new guest. Treat it like the venue saying hi. Warm, low-pressure. Do not pitch anything, do not list benefits, and do not ask the guest to do anything in return. If the guest's name is provided, you may use it once, naturally. The goal is to feel like a door has opened, not like an onboarding email.`
