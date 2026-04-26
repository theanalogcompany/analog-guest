import { sendMessage } from '@/lib/messaging'

async function main(): Promise<void> {
  const to = process.argv[2]
  const body = process.argv[3] ?? 'hello from analog 👋'
  const venueId = process.env.TEST_VENUE_ID

  if (!to) {
    console.error('✗ usage: send-test <recipient-phone> [body]')
    process.exit(1)
  }
  if (!venueId) {
    console.error('✗ missing env var: TEST_VENUE_ID')
    process.exit(1)
  }

  const result = await sendMessage({ venueId, to, body })

  if (!result.ok) {
    console.error(`✗ send failed: ${result.error}${result.errorCode ? ` (${result.errorCode})` : ''}`)
    process.exit(1)
  }

  console.log(`✓ sent | providerMessageId=${result.data.providerMessageId} | status=${result.data.status}`)
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`✗ unexpected error: ${message}`)
  process.exit(1)
})