name: execute
description: Execute a plan by implementing changes incrementally

## Steps

1. Read the plan tasks in order.
2. For each task, read the files that need to be changed.
3. Use fs.write to create new files or apply_patch to edit existing files.
4. Verify that the change compiles / passes after each substep.
5. Mark each subtask done when completed.

Useful tool: `task_list` to see named tasks, `task_update` to mark them done.