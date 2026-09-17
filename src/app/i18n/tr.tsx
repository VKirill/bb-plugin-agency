import { tr } from "./index";

/**
 * Translation at render time. Use it for texts inside JSX that is created
 * outside a component — module constants, option lists, hint maps: `tr()`
 * there would run once at import and stay Russian.
 */
export function Tr({ text, vars }: { text: string; vars?: Record<string, string | number | null | undefined> }) {
  return <>{tr(text, vars)}</>;
}
