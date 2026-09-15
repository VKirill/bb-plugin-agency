/** Product copy for server codes/reasons. Technical text stays behind `technicalServerReason`. */

export const PRODUCT_ASSIGNEE_REQUIRED = "Сначала назначьте исполнителя из состава этого отдела.";
export const PRODUCT_HANDSHAKE_UNREADY =
  "Среда ещё не подтвердила изолированный запуск. Версия программы и название сервера кнопку не открывают.";
export const PRODUCT_CLAUDE_ONLY =
  "Запуск проверен только для сотрудника на Claude. Другого исполнителя запустить нельзя.";
export const PRODUCT_LAUNCH_UNAVAILABLE = "Сейчас запуск недоступен.";
export const PRODUCT_LAUNCH_READY = "Готово к запуску";
export const PRODUCT_LAUNCH_STARTED = "Запуск начат";
export const PRODUCT_LAUNCH_REFUSED = "Запуск отклонён.";
export const PRODUCT_PUBLICATION_VERIFIED = "Файл опубликован; результат ожидает приёмки";

const CODE_PRODUCT: Record<string, string> = {
  assignee_required: PRODUCT_ASSIGNEE_REQUIRED,
  assignee_not_member:
    "Исполнитель должен состоять в выбранном отделе. Выберите сотрудника из состава отдела.",
  handshake_unready: PRODUCT_HANDSHAKE_UNREADY,
  isolation_unproven: PRODUCT_CLAUDE_ONLY,
  launch_not_authorized: PRODUCT_LAUNCH_UNAVAILABLE,
};

export function productFromReasonCode(code: string | null | undefined): string | null {
  if (!code?.trim()) return null;
  if (code === "ok") return PRODUCT_LAUNCH_READY;
  return CODE_PRODUCT[code] ?? null;
}

/** Codes first; English `reason` is fallback / technical. `ok` is ready, not unavailable. */
export function productLaunchCopy(input: {
  reasonCode?: string | null;
  reason?: string | null;
}): string {
  if (input.reasonCode === "ok") return PRODUCT_LAUNCH_READY;
  return productFromReasonCode(input.reasonCode) ?? productServerReason(input.reason);
}

const REASON_PRODUCT: { match: RegExp; text: string }[] = [
  { match: /assignedAgentId is required/i, text: PRODUCT_ASSIGNEE_REQUIRED },
  { match: /assignee_required/i, text: PRODUCT_ASSIGNEE_REQUIRED },
  {
    match: /experimental_thread-spawn-contract|GET\s+\/api\/v1\/system/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  {
    match: /typed runtime capability|instance names are not evidence|Engines|SDK 0\.4|ordinary SDK/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  {
    match: /Isolation and isolated spawn fields are not proven/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  {
    match: /isolation proven only for claude|CLAUDE_ONLY_ISOLATION/i,
    text: PRODUCT_CLAUDE_ONLY,
  },
  { match: /verified bind applied/i, text: PRODUCT_LAUNCH_STARTED },
];

export function productInterpretNotice(view: {
  publishedVerified?: boolean;
  mayEnterReview?: boolean;
  runFailed?: boolean;
  reason: string;
}): string {
  if (view.runFailed) return productServerReason(view.reason);
  if (view.publishedVerified || view.mayEnterReview) return PRODUCT_PUBLICATION_VERIFIED;
  return productServerReason(view.reason);
}

export function productPrepareLaunchNotice(view: {
  handshakeReady: boolean;
  launched: { kind: string } | null;
  reasonCode?: string | null;
  reason: string;
}): string {
  if (view.launched?.kind === "running" || /verified bind applied/i.test(view.reason)) {
    return PRODUCT_LAUNCH_STARTED;
  }
  if (!view.handshakeReady || view.launched?.kind === "failed") {
    const copy = productLaunchCopy({ reasonCode: view.reasonCode, reason: view.reason });
    if (copy === PRODUCT_LAUNCH_READY) return PRODUCT_LAUNCH_REFUSED;
    return copy;
  }
  return productLaunchCopy({ reasonCode: view.reasonCode, reason: view.reason });
}


export function looksTechnicalReason(raw: string): boolean {
  return /\/api\/|assignedAgentId|spawn-contract|TypeScript|SDK|Engines|ThreadSpawnArgs|handshake protocol|fingerprint confirms/i.test(
    raw,
  );
}

export function productServerReason(raw: string | null | undefined): string {
  if (!raw?.trim()) return PRODUCT_LAUNCH_UNAVAILABLE;
  for (const row of REASON_PRODUCT) {
    if (row.match.test(raw)) return row.text;
  }
  if (looksTechnicalReason(raw)) return PRODUCT_LAUNCH_UNAVAILABLE;
  return raw;
}

export function productDomainNotice(code: string, message: string): string {
  return CODE_PRODUCT[code] ?? productServerReason(message);
}

export function technicalServerReason(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  if (productServerReason(raw) === raw) return null;
  return raw;
}

export function technicalLaunchReason(input: {
  reasonCode?: string | null;
  reason?: string | null;
}): string | null {
  const raw = input.reason?.trim();
  if (!raw) return null;
  if (productLaunchCopy(input) === raw) return null;
  return raw;
}
