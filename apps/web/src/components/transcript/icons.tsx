import type { PlanStep } from "@codepilot/core";

import type { SubagentRun } from "../../state/reducer.js";
import { toolCategory, type ToolCategory } from "../../state/selectors.js";
import {
  AlertIcon,
  BookIcon,
  BrainIcon,
  CheckIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  GlobeIcon,
  ListIcon,
  PencilIcon,
  QuestionIcon,
  SearchIcon,
  SpinnerIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
  XIcon,
} from "../Icons.js";

export const CATEGORY_ICON: Record<ToolCategory, (p: { className?: string }) => React.ReactElement> = {
  read: BookIcon,
  list: FolderIcon,
  search: SearchIcon,
  edit: PencilIcon,
  write: FilePlusIcon,
  bash: TerminalIcon,
  web: GlobeIcon,
  task: UsersIcon,
  memory: BrainIcon,
  plan: ListIcon,
  ask: QuestionIcon,
  other: WrenchIcon,
};

export function CategoryIcon({ name, className }: { name: string; className?: string }): React.ReactElement {
  const Icon = CATEGORY_ICON[toolCategory(name)];
  return <Icon className={className} />;
}

export function StepMark({ status }: { status: PlanStep["status"] }): React.ReactElement {
  if (status === "completed") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-add)] text-white">
        <CheckIcon className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--color-accent)]">
        <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-[var(--color-accent)]" />
      </span>
    );
  }
  return <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-[1.5px] border-[var(--color-edge)]" />;
}

export function SubagentStateIcon({ state }: { state: SubagentRun["state"] }): React.ReactElement {
  if (state === "running") return <SpinnerIcon className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />;
  if (state === "failed") return <XIcon className="h-3 w-3 shrink-0 text-[var(--color-remove)]" />;
  return <CheckIcon className="h-3 w-3 shrink-0 text-[var(--color-add)]" />;
}