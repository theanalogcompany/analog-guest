import { redirect } from 'next/navigation'
import { TESTS_SUBNAV } from './_lib/subnav'

// /admin/tests has no content of its own - it redirects to the first surface
// in the sub-nav rather than rendering a landing page nobody needs. Reading
// the destination off TESTS_SUBNAV means the nav item, the sub-nav bar and
// this redirect cannot disagree about where Tests goes.

export default function TestsIndexPage() {
  redirect(TESTS_SUBNAV[0].href)
}
