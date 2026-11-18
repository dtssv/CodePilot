/** Tool-Use Policy bullets — gated by the tools exposed this session. */

interface PolicyBullet {
  requires?: string[];
  text: string;
}

export function toolUsePolicy(toolNames: string[]): string {
  const have = new Set(toolNames);
  const mutators = ["apply_patch", "edit_file", "write_file"].filter((n) => have.has(n));
  const canMutate = mutators.length > 0;
  const researchHow = canMutate
    ? `How: (1) same turn — locate files + run the failing check when both are known; (2) \`read_file\`/\`grep\` the failing paths; (3) edit with ${mutators
        .map((n) => `\`${n}\``)
        .join("/")} whose context matches disk; (4) re-run the check. Do not burn turns on \`ls\`→\`cat\`→\`test\` one at a time.`
    : `How: gather evidence with available read tools in parallel before answering; do not burn turns on serial shell \`cat\`/\`ls\` when file tools exist.`;

  const bullets: PolicyBullet[] = [
    {
      text: `- **Research before you mutate.** ${researchHow}`,
    },
    {
      text: `- **Parallelise by default.** Put every independent call in the **same** response. Only chain when B needs A's output (e.g. edit after you know the failing file from the test log).`,
    },
    {
      requires: ["task"],
      text: `- **Delegate with \`task\`.** Broad multi-hop search or parallel independent work → \`task\`. Never for a single read/grep/one-file fix. **If the user explicitly asks to spawn / use a subagent or \`task\`**, call \`task\` — do **not** self-exec. One ordered ask → **one** OBJECTIVE; split only for requested parallel fan-out. Brief with paths/ruled-out/acceptance (see \`task\` schema).`,
    },
    {
      requires: ["task"],
      text: `- **Trust what \`task\` returns.** Fold conclusions; do not re-do the same search. Sample-verify before high-risk mutations or absence/security claims; if the conclusion already answers, summarise and stop. Prefer \`continue_session_id\` over re-dispatch; on **Blocker** honour \`need\` then resume.`,
    },
    {
      requires: ["ask_user_question"],
      text: `- **Ask the user vs explore.** Missing **facts** in the repo/docs → read or \`task\` explore first. Missing **preference, authorization, or acceptance criteria** only the user can give → \`ask_user_question\`. Do not ask the user what you can verify with tools.`,
    },
    {
      requires: ["read_artifact"],
      text: `- **Use artifacts for large output.** Leave hundreds-of-lines output as an artifact reference and pull slices with \`read_artifact\`. Do not paste big outputs into the conversation.`,
    },
    {
      text: `- **Sample data before loading it.** Tool output is re-sent every later turn — \`maxLines\`/\`head\`/\`wc\` first; never dump whole logs/fixtures.`,
    },
    {
      text: `- **Recover, do not give up.** On tool **error**, classify (business / permission / transient — see Doing tasks); fix once; do not loop the same failing call. After a **successful** write, prefer the milestone check over speculative re-read/repair; if the write was wrong, re-issue with the **same** mutator on those paths.`,
    },
    {
      requires: ["bash"],
      text: `- **Permission denied ≠ retry with tweaks.** A denied \`bash\` is a sandbox/permission block — switch tools or request access; do not re-run with different args.`,
    },
    {
      requires: ["read_file"],
      text: `- **Re-read when content is gone.** Visible output → window with \`startLine\`/\`maxLines\`.${
        have.has("read_artifact")
          ? " Folded \`art_<hash>\` → \`read_artifact\` (re-run producer **at most once** if the ref is gone; never invent the body)."
          : ""
      } Missing body and no artifact ref → treat as **unread** and \`read_file\` again.`,
    },
  ];

  const rendered = bullets
    .filter((b) => !b.requires || b.requires.every((t) => have.has(t)))
    .map((b) => b.text);
  const neverParts = [
    "invent an implementation from a one-line guess",
    "interleave tiny-edit→verify→tiny-edit as the main cadence",
  ];
  if (have.has("bash") || have.has("read_file") || have.has("grep")) {
    neverParts.push("use bash/cat/sed to read or edit source when file tools exist");
  }
  if (have.has("bash")) neverParts.push("retry a permission-denied tool with tweaked args");
  if (
    have.has("apply_patch") &&
    (have.has("edit_file") || have.has("write_file"))
  ) {
    neverParts.push(
      "mix `apply_patch` with `edit_file`/`write_file` on the same path in one fix set (later turns too) — pick one mutator per path",
    );
  }
  return "\n" + rendered.join("\n") + "\nNever: " + neverParts.join("; ") + ".";
}
