export type IsolatedThreadSendArgs = {
  threadId: string;
  text: string;
};

export type IsolatedSendOutcome =
  | { kind: "confirmed"; delivery: "sent"; queuedMessageId?: undefined }
  | { kind: "confirmed"; delivery: "queued"; queuedMessageId?: string }
  | { kind: "unknown"; code: string; message: string }
  | { kind: "rejected"; code: string; message: string };

export type ContinuationPresence = "present" | "queued" | "absent" | "unknown";

export type IsolatedSendPort = {
  send(args: IsolatedThreadSendArgs): Promise<IsolatedSendOutcome>;
  recoverContinuation(
    threadId: string,
    token: string,
    queuedMessageId?: string | null,
  ): Promise<ContinuationPresence>;
};

type IsolatedSendSurface = {
  send?: IsolatedSendPort["send"];
  hasContinuation?: IsolatedSendPort["recoverContinuation"];
};

export function createIsolatedSendPort(threads: IsolatedSendSurface): IsolatedSendPort {
  return {
    async send(args: IsolatedThreadSendArgs): Promise<IsolatedSendOutcome> {
      if (!threads.send) {
        return {
          kind: "rejected",
          code: "sdk_send_unsupported",
          message: "official threads.send is not bound on this IsolatedThreadsApi",
        };
      }
      try {
        const result = await threads.send(args);
        if (result.kind === "confirmed" || result.kind === "unknown") return result;
        return { kind: "unknown", code: "send_result_unrecognized", message: "threads.send returned no delivery" };
      } catch (error) {
        return {
          kind: "unknown",
          code: "send_transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async recoverContinuation(
      threadId: string,
      token: string,
      queuedMessageId?: string | null,
    ): Promise<ContinuationPresence> {
      if (!threads.hasContinuation) return "unknown";
      try {
        return await threads.hasContinuation(threadId, token, queuedMessageId);
      } catch {
        return "unknown";
      }
    },
  };
}
