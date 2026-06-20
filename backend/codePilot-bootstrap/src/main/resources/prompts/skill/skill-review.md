name: review
description: Review code changes for quality, bugs, and style consistency

## Steps

1. List all files that were changed (use grep or fs.list to discover).
2. Read each changed file.
3. Check for:
   - Logic errors or edge cases
   - Security issues (injection, unsafe file access)
   - Style consistency with project conventions
   - Performance issues (N+1 queries, excessive allocations)
   - Test coverage gaps
4. Suggest improvements with clear before/after examples.
5. Rank issues by severity.