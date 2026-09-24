export type FailureKind = "auth" | "context" | "model" | "environment" | "capacity" | "transient" | "unknown";
/** Classification guides escalation; it never grants credentials or changes models. */
export function failureKind(detail: string | null | undefined): FailureKind {
  const text = detail ?? "";
  if (/\b(401|403)\b|unauthenticated|unauthorized|forbidden|invalid.{0,20}(api.?key|token)|token.{0,20}expired|authentication[_ ](failed|required|error)|not (logged|signed) in/i.test(text)) return "auth";
  if (/context[_ ](?:window|length)|context(?! deadline).{0,20}(exceed|too (large|long))|maximum.{0,10}context|prompt.{0,15}too long|too many tokens/i.test(text)) return "context";
  if (/model[_ ]not[_ ]found|unknown model|unsupported model|invalid model|model.{0,40}(does not exist|not available)/i.test(text)) return "model";
  if (/\b(ENOENT|EACCES|EPERM|ENOSPC)\b|command not found|permission denied|no space left|working directory.{0,25}(missing|not found)|executable.{0,25}(missing|not found)/i.test(text)) return "environment";
  if (/usage limit|usageLimitExceeded|quota|subscription|rate.?limit|too many requests|\b429\b|insufficient balance/i.test(text)) return "capacity";
  if (/\b50[0-9]\b|overload|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|not connected|disconnect|host_unavailable/i.test(text)) return "transient";
  return "unknown";
}
export function failureAdvice(kind: FailureKind, en: boolean): string {
  const advice: Record<FailureKind, [string,string]> = {
    auth: ["Check the provider sign-in, token validity and required permissions through the credential catalog; retrying cannot grant access.", "Проверьте вход провайдера, срок токена и нужные права через каталог доступов; повтор запуска не выдаёт доступ."],
    context: ["Save the checkpoint and use the provider's supported context continuation/compaction; retain the task and acceptance criteria.", "Сохраните checkpoint и используйте штатное продолжение/сжатие контекста провайдера; сохраните задачу и критерии приёмки."],
    model: ["Check the selected model and its availability in the provider catalog; use only an authorized profile.", "Проверьте выбранную модель и её доступность в каталоге провайдера; используйте только разрешённый профиль."],
    environment: ["Check the executable, working directory, filesystem permissions and free space on the execution host.", "Проверьте CLI, рабочую папку, права на файлы и свободное место на хосте исполнения."],
    capacity: ["Check the subscription reset, balance and BB retry queue; use only an owner-authorized reserve.", "Проверьте сброс лимита, баланс и очередь retry BB; резерв — только разрешённый владельцем."],
    transient: ["Check host/provider availability and the exact failed turn. No BB retry is confirmed; diagnose before continuing the same attempt.", "Проверьте доступность хоста/провайдера и конкретный упавший ход. Retry BB не подтверждён; сначала установите причину, затем продолжайте ту же попытку."],
    unknown: ["Inspect the failed turn and provider diagnostics; do not assume a subscription limit or restart blindly.", "Откройте упавший ход и диагностику провайдера; не предполагайте лимит подписки и не перезапускайте вслепую."],
  };
  return advice[kind][en ? 0 : 1];
}
