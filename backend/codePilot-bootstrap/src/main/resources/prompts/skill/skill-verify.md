name: verify
description: Verify that a change works correctly

## Steps

1. Build the project (shell.exec: build command).
2. Run the full test suite (shell.exec: test command).
3. Check for any failing tests.
4. Verify that the behavior matches the requirements.
5. Report pass/fail with details on any remaining failures.