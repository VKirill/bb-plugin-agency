import type { SessionEffectiveMode, SessionPolicyMode, SessionPolicyView } from "../shared/contracts/session-policy";

/** Three choices people see. inherit/delegate/pm all read as Agency. */
export const USER_SESSION_CHOICES = ["pm", "suggest", "ordinary"] as const;
export type UserSessionChoice = (typeof USER_SESSION_CHOICES)[number];

export const SESSION_MODE_OPTIONS: { value: UserSessionChoice; label: string }[] = [
  { value: "pm", label: "Агентство" },
  { value: "suggest", label: "По запросу" },
  { value: "ordinary", label: "Сам сделает" },
];

export function userSessionChoice(mode: SessionEffectiveMode | SessionPolicyMode): UserSessionChoice {
  if (mode === "suggest") return "suggest";
  if (mode === "ordinary") return "ordinary";
  return "pm";
}

/**
 * Chip label for this composer. A new-chat draft (`pending`) is the choice until
 * this thread has its own row — BB often allocates the thread id before first send,
 * and `effective` stays the project/Agency default until then.
 */
export function composerChosenMode(policy: SessionPolicyView | null, isNewThread: boolean): SessionEffectiveMode | SessionPolicyMode {
  const pending = policy?.pending;
  const thread = policy?.layers.thread;
  if (pending && pending !== "inherit" && (isNewThread || thread === "inherit")) return pending;
  if (thread && thread !== "inherit") return thread;
  return policy?.effective ?? "pm";
}

export function userSessionLabel(mode: SessionEffectiveMode | SessionPolicyMode): string {
  const choice = userSessionChoice(mode);
  if (choice === "suggest") return "По запросу";
  if (choice === "ordinary") return "Сам сделает";
  return "Агентство";
}

export function effectiveModeLabel(mode: SessionEffectiveMode): string {
  return userSessionLabel(mode);
}

export function composerModeLabel(mode: SessionEffectiveMode): string {
  return userSessionLabel(mode);
}

const STICKY_TTL_MS = 30 * 60 * 1000;
const CHOICE_SET = new Set<string>(USER_SESSION_CHOICES);

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function composerStickyKey(kind: "pending" | "thread", id: string): string {
  return `agency.session.${kind}:${id}`;
}

function readStoredChoice(key: string): UserSessionChoice | null {
  const raw = sessionStore()?.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; at?: unknown };
    if (!CHOICE_SET.has(String(parsed.mode)) || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > STICKY_TTL_MS) return null;
    return parsed.mode as UserSessionChoice;
  } catch {
    return null;
  }
}

function writeStoredChoice(key: string, mode: UserSessionChoice): void {
  sessionStore()?.setItem(key, JSON.stringify({ mode, at: Date.now() }));
}

/** Last explicit chip click in this browser tab. Wins over a stale GET that still reports Agency. */
export function readComposerSticky(input: {
  projectId?: string | null;
  threadId?: string | null;
  isNewThread: boolean;
}): UserSessionChoice | null {
  if (input.threadId) {
    const thread = readStoredChoice(composerStickyKey("thread", input.threadId));
    if (thread) return thread;
  }
  if (input.projectId) {
    const pending = readStoredChoice(composerStickyKey("pending", input.projectId));
    if (pending && (input.isNewThread || Boolean(input.threadId))) return pending;
  }
  return null;
}

export function writeComposerSticky(input: {
  projectId?: string | null;
  threadId?: string | null;
  isNewThread: boolean;
  mode: UserSessionChoice;
}): void {
  if (input.isNewThread && input.projectId) {
    writeStoredChoice(composerStickyKey("pending", input.projectId), input.mode);
    return;
  }
  if (input.threadId) writeStoredChoice(composerStickyKey("thread", input.threadId), input.mode);
}

/** Move the new-chat draft onto this thread id so a remount does not fall back to Agency. */
export function consumePendingSticky(projectId: string | undefined, threadId: string): UserSessionChoice | null {
  if (!projectId) return null;
  const pending = readStoredChoice(composerStickyKey("pending", projectId));
  if (!pending) return null;
  writeStoredChoice(composerStickyKey("thread", threadId), pending);
  sessionStore()?.removeItem(composerStickyKey("pending", projectId));
  return pending;
}

export function displayedComposerChoice(
  policy: SessionPolicyView | null,
  isNewThread: boolean,
  sticky: UserSessionChoice | null,
): UserSessionChoice {
  if (sticky) return sticky;
  return userSessionChoice(composerChosenMode(policy, isNewThread));
}
