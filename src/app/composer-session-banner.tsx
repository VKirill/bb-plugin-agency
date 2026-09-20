import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useBbContext, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../shared/rpc-contract";
import type { SessionEffectiveMode, SessionPolicyMode, SessionPolicyView } from "../shared/contracts/session-policy";
import { tr } from "./i18n";
import { composerModeLabel, effectiveModeLabel, SESSION_MODE_OPTIONS, userSessionChoice } from "./session-mode-copy";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";

function newRequestId(): string {
  return crypto.randomUUID();
}

function connectedIds(scope: ReturnType<typeof useComposerView>["scope"]): { bbProjectId?: string; threadId?: string } {
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return { threadId: scope.threadId };
  }
  if (scope.kind === "side-chat") {
    return { bbProjectId: scope.projectId, threadId: scope.childThreadId ?? scope.parentThreadId };
  }
  return { bbProjectId: scope.projectId ?? undefined };
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
  const scoped = connectedIds(view.scope);
  const ids = {
    bbProjectId: scoped.bbProjectId ?? bb.projectId ?? undefined,
    threadId: scoped.threadId ?? (view.scope.kind === "thread" ? view.scope.threadId : undefined) ?? bb.threadId ?? undefined,
  };
  const [policy, setPolicy] = useState<SessionPolicyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const load = useCallback(() => {
    if (!ids.bbProjectId && !ids.threadId) {
      setPolicy(null);
      return;
    }
    void rpc
      .call("getSessionPolicy", { bbProjectId: ids.bbProjectId, threadId: ids.threadId })
      .then((result) => {
        if (result.ok) setPolicy(result.value);
      })
      .catch(() => undefined);
  }, [rpc, ids.bbProjectId, ids.threadId]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime("domain-changed", load);
  const canOverride =
    (Boolean(ids.threadId) && view.scope.kind !== "new-thread") ||
    (view.scope.kind === "new-thread" && Boolean(ids.bbProjectId));
  const setMode = async (mode: SessionPolicyMode) => {
    const current = userSessionChoice(policy && policy.layers.thread !== "inherit" ? policy.layers.thread : (policy?.effective ?? "pm"));
    if (mode === current) return;
    setBusy(true);
    try {
      if (ids.threadId && view.scope.kind !== "new-thread") {
        await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "thread", scopeId: ids.threadId, mode });
      } else if (ids.bbProjectId) {
        await rpc.call("saveSessionPolicy", { requestId: newRequestId(), scope: "project", scopeId: ids.bbProjectId, mode });
      }
      load();
    } finally {
      setBusy(false);
    }
  };
  const effective = (policy?.effective ?? "pm") as SessionEffectiveMode;
  const selected = userSessionChoice(effective);
  const shortLabel = tr(composerModeLabel(effective));
  const fullLabel = `${tr("Агентство")}: ${tr(effectiveModeLabel(effective))}`;
  const hint =
    view.scope.kind === "new-thread"
      ? fullLabel
      : canOverride
        ? fullLabel
        : tr("После отправки этот чат можно сменить на один раз.");
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
                  onMouseDown={holdComposer}
                  onClick={() => {
                    setMenuOpen(false);
                    void setMode(choice.value);
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
