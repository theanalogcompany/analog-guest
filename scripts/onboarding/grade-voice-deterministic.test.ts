import { describe, expect, it } from 'vitest'
import { gradeVoiceDeterministic } from './grade-voice-deterministic'

const base = {
  category: 'venue_topic',
  emojiPolicy: 'sparingly' as const,
  speakerFraming: 'named_person' as const,
  speakerName: 'Himanshu',
  knownPhones: [] as string[],
  knownDomains: ['lemils.com'],
}

describe('gradeVoiceDeterministic', () => {
  it('passes a clean reply', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'yeah we ship anywhere in the US, lemils.com has details 🙌' })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('flags an em dash', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'sure — we can do that' })
    expect(result.findings.map((f) => f.check)).toContain('dash')
  })

  it('flags an en dash', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'open 9–5 today' })
    expect(result.findings.map((f) => f.check)).toContain('dash')
  })

  it('flags self-talk — the literal le-mils-coffee-010 failing reply (TAC-355)', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      replyBody:
        "No coffee-based decaf, but the Almost Latte is caffeine-free. It's made with chicory, nutmeg, and dandelion root — actually wait, no dashes. Chicory, nutmeg, and dandelion root extract. Tastes a lot like filter coffee though 🙂",
    })
    expect(result.findings.map((f) => f.check)).toContain('self_talk')
  })

  it('does not flag an ordinary reply for self-talk', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      replyBody: 'we open at 7 and close at 3 on weekdays, come by any time',
    })
    expect(result.findings.map((f) => f.check)).not.toContain('self_talk')
  })

  it('flags a reply over three sentences (of 5+ words each)', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      replyBody: 'This is sentence number one here. This is sentence number two here. This is sentence number three here. This is sentence number four here.',
    })
    expect(result.findings.map((f) => f.check)).toContain('length')
  })

  it('does not flag exactly three long sentences', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      replyBody: 'This is sentence number one here. This is sentence number two here. This is sentence number three here.',
    })
    expect(result.findings.map((f) => f.check)).not.toContain('length')
  })

  it('short sentences (under 5 words) do not count toward the sentence limit', () => {
    // Four sentences, but three of them are under 5 words — only "hey."
    // and "are you doing okay right now" would count, well under the cap.
    const result = gradeVoiceDeterministic({
      ...base,
      replyBody: "hey. I'm glad you texted. that sounds heavy. are you doing okay right now?",
    })
    expect(result.findings.map((f) => f.check)).not.toContain('length')
  })

  it('flags a reply over 280 characters regardless of sentence count', () => {
    const long = 'a'.repeat(150) + '. ' + 'b'.repeat(150) + '.'
    const result = gradeVoiceDeterministic({ ...base, replyBody: long })
    expect(result.findings.map((f) => f.check)).toContain('length')
  })

  it('exempts safety_critical scenarios from the length check entirely', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      category: 'adversarial_safety_critical',
      replyBody:
        'Call 911 right now. This is a medical emergency and you need help immediately. Please call 911 as soon as you can. Do not wait another minute to call.',
    })
    expect(result.findings.map((f) => f.check)).not.toContain('length')
  })

  it('skips the voice check entirely for safety_critical (not just length) — owner decision: clarity wins in an emergency', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      category: 'adversarial_safety_critical',
      emojiPolicy: 'never',
      replyBody: 'call 911 right now — do not wait 🙏\n- Himanshu',
    })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('never policy fails on any emoji', () => {
    const result = gradeVoiceDeterministic({ ...base, emojiPolicy: 'never', replyBody: 'sure thing 🙌' })
    expect(result.findings.map((f) => f.check)).toContain('emoji_policy')
  })

  it('sparingly policy allows exactly one emoji', () => {
    const result = gradeVoiceDeterministic({ ...base, emojiPolicy: 'sparingly', replyBody: 'sure thing 🙌' })
    expect(result.findings.map((f) => f.check)).not.toContain('emoji_policy')
  })

  it('sparingly policy fails on two or more emoji', () => {
    const result = gradeVoiceDeterministic({ ...base, emojiPolicy: 'sparingly', replyBody: 'sure thing 🙌 ☕' })
    expect(result.findings.map((f) => f.check)).toContain('emoji_policy')
  })

  it('frequent policy never fails on emoji count', () => {
    const result = gradeVoiceDeterministic({ ...base, emojiPolicy: 'frequent', replyBody: '🙌 ☕ 😄 🎉' })
    expect(result.findings.map((f) => f.check)).not.toContain('emoji_policy')
  })

  it('flags an email-style sign-off', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'sure thing, come by anytime.\n- Himanshu' })
    expect(result.findings.map((f) => f.check)).toContain('signed_name')
  })

  it('flags a phone number not in venue data', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'call us at 415-555-0123' })
    expect(result.findings.map((f) => f.check)).toContain('phone_or_link')
  })

  it('does not flag a phone number that matches venue data', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      knownPhones: ['+14155550123'],
      replyBody: 'call us at 415-555-0123',
    })
    expect(result.findings.map((f) => f.check)).not.toContain('phone_or_link')
  })

  it('flags a link not in venue data', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'check out competitorcafe.com for that' })
    expect(result.findings.map((f) => f.check)).toContain('phone_or_link')
  })

  it('does not flag a link that matches venue data', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'order at lemils.com anytime' })
    expect(result.findings.map((f) => f.check)).not.toContain('phone_or_link')
  })

  it('flags third-person self-reference', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: 'best to check with Himanshu about that' })
    expect(result.findings.map((f) => f.check)).toContain('third_person_self')
  })

  it('does not flag first-person self-introduction', () => {
    const result = gradeVoiceDeterministic({ ...base, replyBody: "that's me, I'm Himanshu, happy to help" })
    expect(result.findings.map((f) => f.check)).not.toContain('third_person_self')
  })

  it('skips third-person check entirely when speakerFraming is venue', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      speakerFraming: 'venue',
      speakerName: undefined,
      replyBody: 'best to check with Himanshu about that',
    })
    expect(result.findings.map((f) => f.check)).not.toContain('third_person_self')
  })

  it('accumulates multiple findings on one bad reply', () => {
    const result = gradeVoiceDeterministic({
      ...base,
      emojiPolicy: 'never',
      replyBody: 'sure — call 415-555-0199 anytime 🙌\n- Himanshu',
    })
    const checks = result.findings.map((f) => f.check)
    expect(checks).toContain('dash')
    expect(checks).toContain('emoji_policy')
    expect(checks).toContain('phone_or_link')
    expect(checks).toContain('signed_name')
    expect(result.pass).toBe(false)
  })
})
