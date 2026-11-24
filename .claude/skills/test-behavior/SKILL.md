---
name: test-behavior
description: Check that a board test fails when its claimed behavior breaks. Use for every test you write, change, or review.
---

# Test behavior

- **See it fail.** Break what the test claims to check and run it. Make sure
  it fails for that reason, then restore the behavior and see it pass.
- **Use public interfaces.** Test through the CLI, the board handle, or the
  HTTP API. Assert what a user can observe, not private functions, call counts,
  or other implementation details.
- **Match evidence to the claim.** Say which test failed, what you broke, and
  which interface you exercised. For a bug fix, show the wrong result without
  the fix and the right result with it.
- **Don't mock board's own code.** Use a real board. Fake an external service
  if needed, and say what you faked.
