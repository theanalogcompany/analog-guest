// Is every archived V2TemplateSet a BYTE-FOR-BYTE copy of what template.ts
// exported at the commit it names?
//
// The archive's own header says "extracted by script from git, never retyped",
// which is a claim about bytes that nothing enforced. This compares each set
// against the real blob by importing the git version of the module, so a
// hand-retyped fixture that drifted by one backslash fails here rather than
// silently measuring a version that never shipped.
//
//   npx tsx scripts/measurement/cold-latte-archive-check.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2_TEMPLATE_SETS } from '@/lib/ai/v2/template-archive'

/**
 * The commit whose template.ts each archived version claims to copy.
 *
 * PINNED SHAs, never `HEAD`. A check against HEAD passes trivially on the
 * commit that writes the fixture and then compares the fixture to whatever
 * landed next, which is the opposite of what it claims to prove.
 */
const SOURCES: Record<string, string> = {
  // v2.19.0 and v2.18.0 share one copy of the strings in the archive, on
  // v2.19.0's claim that it changed no template copy. Both keys are checked
  // against their OWN commit, which is what turns that claim into something
  // that can fail.
  'v2.19.0-draft': '559529a950594ef52ae5799bebbf4985d5dd61f9',
  'v2.18.0-draft': '6effcdcfbfd4acbcc47b0f229b0817d9a985892b',
  'v2.17.0-draft': '53b52347bc',
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'archive-check-'))
  let failures = 0
  for (const [version, commit] of Object.entries(SOURCES)) {
    const set = V2_TEMPLATE_SETS[version]
    if (set === undefined) {
      console.log(`MISSING  ${version} is not in V2_TEMPLATE_SETS`)
      failures++
      continue
    }
    // Import the historical module directly. Parsing the template literals out
    // of the text with a regex would be a second definition of how a template
    // literal escapes, which is the exact thing under test.
    const blob = execFileSync(
      'git',
      ['show', `${commit}:lib/ai/v2/template.ts`],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    )
    const file = join(dir, `${version.replace(/\W/g, '_')}.ts`)
    writeFileSync(file, blob)
    const past = (await import(file)) as Record<string, string>
    const fields: Array<[string, string | undefined, string | undefined]> = [
      ['version', set.version, past.V2_PROMPT_VERSION],
      ['frame', set.frame, past.V2_FRAME],
      ['houseSections', set.houseSections, past.V2_HOUSE_SECTIONS],
      [
        'houseSectionsBriefed',
        set.houseSectionsBriefed,
        past.V2_HOUSE_SECTIONS_BRIEFED,
      ],
      ['guestState', set.guestState, past.V2_GUEST_STATE],
    ]
    for (const [name, archived, actual] of fields) {
      if (archived === undefined && actual === undefined) continue
      if (archived === actual) {
        console.log(`ok       ${version} ${name}`)
        continue
      }
      failures++
      console.log(`DRIFT    ${version} ${name}`)
      if (archived === undefined || actual === undefined) {
        console.log(
          `  archived ${archived === undefined ? 'absent' : 'present'}, commit ${actual === undefined ? 'absent' : 'present'}`,
        )
        continue
      }
      let i = 0
      while (
        i < archived.length &&
        i < actual.length &&
        archived[i] === actual[i]
      )
        i++
      console.log(`  first difference at char ${i}`)
      console.log(`  archived: ${JSON.stringify(archived.slice(i, i + 160))}`)
      console.log(`  ${commit}: ${JSON.stringify(actual.slice(i, i + 160))}`)
    }
  }
  console.log(
    failures === 0 ? '\nALL VERBATIM' : `\n${failures} FIELD(S) DRIFTED`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
