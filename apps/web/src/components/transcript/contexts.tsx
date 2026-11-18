import { createContext } from "react";

import type { SubagentNav } from "./types.js";

export const SubagentContext = createContext<SubagentNav | undefined>(undefined);
export const OpenPathContext = createContext<((path: string, line?: number) => void) | undefined>(undefined);
export const InsertCodeContext = createContext<((text: string) => boolean) | undefined>(undefined);