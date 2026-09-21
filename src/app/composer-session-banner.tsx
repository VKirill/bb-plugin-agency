import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useBbContext, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../shared/rpc-contract";
import type { SessionEffectiveMode, SessionPolicyMode, SessionPolicyView } from "../shared/contracts/session-policy";
import { tr } from "./i18n";
import {
  composerModeLabel,
  consumePendingSticky,
  displayedComposerChoice,
  effectiveModeLabel,
  readComposerSticky,
  SESSION_MODE_OPTIONS,
  writeComposerSticky,
  type UserSessionChoice,
} from "./session-mode-copy";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";

function newRequestId(): string {
  return crypto.randomUUID();
}

function connectedIds(
  scope: ReturnType<typeof useComposerView>["scope"],
  projectId: string | null,
): { bbProjectId?: string; threadId?: string } {
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return { threadId: scope.threadId, ...(projectId ? { bbProjectId: projectId } : {}) };
  }
  if (scope.kind === "side-chat") {
    return { bbProjectId: scope.projectId, threadId: scope.childThreadId ?? scope.parentThreadId };
  }
  // new-thread has no chat id yet — never borrow bb.threadId of a previous chat.
  return { bbProjectId: scope.projectId ?? projectId ?? undefined };
}

function optimisticPolicy(
  previous: SessionPolicyView | null,
  mode: Exclude<SessionPolicyMode, "inherit">,
  isNewThread: boolean,
  ids: { bbProjectId?: string; threadId?: string },
): SessionPolicyView {
  const base: SessionPolicyView = previous ?? {
    effective: "pm",
    source: "agency",
    layers: { agency: "pm", project: "inherit", binding: "inherit", thread: "inherit" },
    pending: "inherit",
    bbProjectId: ids.bbProjectId ?? null,
    bindingId: null,
    threadId: ids.threadId ?? null,
    connected: true,
  };
  if (isNewThread) return { ...base, pending: mode };
  return {
    ...base,
    effective: mode,
    source: "thread",
    layers: { ...base.layers, thread: mode },
  };
}

/** Keep the follow-up composer expanded: skip keyboard blur / compact hide of plugin actions. */
function holdComposer(event: { preventDefault(): void; stopPropagation(): void }) {
  event.preventDefault();
  event.stopPropagation();
}

const TRIGGER_CLASS =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 border-none bg-transparent px-1 text-xs font-normal leading-tight text-muted-foreground shadow-none hover:text-muted-foreground";

/** Session mode in the composer action row, left of MoA / voice / submit. */
export function ComposerSessionBanner() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const bb = useBbContext();
  const scoped = connectedIds(view.scope, bb.projectId);
  const isNewThread = view.scope.kind === "new-thread";
  const ids = {
    bbProjectId: scoped.bbProjectId ?? bb.projectId ?? undefined,
    threadId: isNewThread
      ? undefined
      : scoped.threadId ?? (view.scope.kind === "thread" ? view.scope.threadId : undefined) ?? bb.threadId ?? undefined,
  };
  const [policy, setPolicy] = useState<SessionPolicyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const loadGen = useRef(0);
  const load = useCallback(() => {
    if (!ids.bbProjectId && !ids.threadId) {
      loadGen.current += 1;
      setPolicy(null);
      return;
    }
    const gen = ++loadGen.current;
    void rpc
      .call("getSessionPolicy", {
        ...(ids.bbProjectId ? { bbProjectId: ids.bbProjectId } : {}),
        ...(ids.threadId ? { threadId: ids.threadId } : {}),
      })
      .then((result) => {
        if (gen !== loadGen.current) return;
        if (result.ok) setPolicy(result.value);
      })
      .catch(() => undefined);
  }, [rpc, ids.bbProjectId, ids.threadId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("domain-changed", load);
  useEffect(() => {
    if (isNewThread || !ids.threadId) return;
    const pinned = consumePendingSticky(ids.bbProjectId, ids.threadId);
    if (!pinned) return;
    loadGen.current += 1;
    setPolicy((prev) => optimisticPolicy(prev, pinned, false, ids));
    void rpc
      .call("saveSessionPolicy", {
        requestId: newRequestId(),
        scope: "thread",
        scopeId: ids.threadId,
        mode: pinned,
      })
      .then((result) => {
        if (result.ok) load();
      })
      .catch(() => undefined);
  }, [isNewThread, ids.bbProjectId, ids.threadId, rpc, load]);
  const canOverride = Boolean(ids.threadId) || (isNewThread && Boolean(ids.bbProjectId));
  const setMode = async (mode: UserSessionChoice) => {
    const sticky = readComposerSticky({ projectId: ids.bbProjectId, threadId: ids.threadId, isNewThread });
    const current = displayedComposerChoice(policy, isNewThread, sticky);
    if (mode === current) return;
    setBusy(true);
    const previous = policy;
    loadGen.current += 1;
    writeComposerSticky({ projectId: ids.bbProjectId, threadId: ids.threadId, isNewThread, mode });
    setPolicy(optimisticPolicy(previous, mode, isNewThread, ids));
    try {
      const result = isNewThread && ids.bbProjectId
        ? await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "pending", scopeId: ids.bbProjectId, mode })
        : ids.threadId
          ? await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "thread", scopeId: ids.threadId, mode })
          : null;
      if (result && !result.ok) return;
      load();
    } catch {
      // Keep the chip on the click; a later GET/retry still has the sticky.
    } finally {
      setBusy(false);
    }
  };
  const pickMode = (mode: UserSessionChoice) => {
    setMenuOpen(false);
    void setMode(mode);
  };
  const sticky = readComposerSticky({ projectId: ids.bbProjectId, threadId: ids.threadId, isNewThread });
  const selected = displayedComposerChoice(policy, isNewThread, sticky);
  const shown = selected as SessionEffectiveMode;
  const shortLabel = tr(composerModeLabel(shown));
  const fullLabel = `${tr("Агентство")}: ${tr(effectiveModeLabel(shown))}`;
  const hint = canOverride ? fullLabel : tr("После отправки этот чат можно сменить на один раз.");
  const sheetTitle = tr("Режим чата Агентства");
  const openMenu = (event: MouseEvent) => {
    holdComposer(event);
    if (!busy && canOverride) setMenuOpen(true);
  };
  const trigger = (
    <Button
      data-testid="agency-session-banner"
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy || !canOverride}
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      aria-label={sheetTitle}
      className={TRIGGER_CLASS}
      onMouseDown={canOverride ? holdComposer : undefined}
      onClick={canOverride ? openMenu : undefined}
    >
      <Icon name="Bot" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{shortLabel}</span>
      {canOverride ? <Icon name="ChevronDown" className="size-3.5 shrink-0 text-subtle-foreground/75" /> : null}
    </Button>
  );
  if (!canOverride) {
    return (
      <span className="inline-flex" title={hint}>
        {trigger}
      </span>
    );
  }
  return (
    <span className="inline-flex" title={hint}>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          data-testid="agency-session-menu"
          align="start"
          mobileTitle={sheetTitle}
          className="flex min-h-0 w-56 flex-col p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            role="listbox"
            aria-label={sheetTitle}
            className="flex flex-col py-1 pb-[max(2.75rem,calc(env(safe-area-inset-bottom)+1.25rem))] sm:pb-1"
          >
            {SESSION_MODE_OPTIONS.map((choice) => {
              const active = choice.value === selected;
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center justify-between gap-3 rounded-sm px-2 py-2 text-xs outline-none hover:bg-state-hover hover:text-foreground",
                    active && "bg-state-active",
                  )}
                  onMouseDown={(event) => {
                    holdComposer(event);
                    pickMode(choice.value);
                  }}
                  onClick={(event) => {
                    holdComposer(event);
                    pickMode(choice.value);
                  }}
                >
                  <span className="truncate">{tr(choice.label)}</span>
                  <Icon
                    name="Check"
                    className={cn("size-3.5 shrink-0 text-subtle-foreground", active ? "opacity-100" : "opacity-0")}
                  />
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
