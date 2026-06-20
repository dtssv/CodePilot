name: plan
description: Create an implementation plan by breaking the task into subtasks

## Steps

1. Read relevant code to understand the codebase context.
2. Break the task into named subtasks (T1, T2, ...).
3. For each subtask, identify which files will be read/modified.
4. Assign dependencies between subtasks.
5. Identify risks and success criteria.

Output format:
```
T1: <first subtask>
  - files to read: [list]
  - files to modify: [list]
  - success criteria: <description>

T2: <second subtask>
  ...
```