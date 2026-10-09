// The regression write routes' gate, now one definition shared with every
// other surface under /admin/tests.
//
// This file was the original; it is kept as a re-export so the regression
// routes keep one import while the surface still lives at /admin/regression,
// and it goes away with the move under tests/. Two copies of an auth gate is
// not a duplication worth carrying for the length of a rename.

export {
  requireTestsAdmin as requireRegressionAdmin,
  type RequireTestsAdminResult as RequireRegressionAdminResult,
} from '../../tests/_lib/require-tests-admin'
