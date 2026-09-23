/**
 * One mark on a line: was this rework the same hypothesis, and why.
 * The classifier only writes the mark. The orchestrator reads `loopEffect`
 * and refuses the next station or the retry into the same thread.
 * No mark, a dead classifier, or confidence under the threshold → allow.
 */

export type LoopRelation = "same_loop" | "new_evidence";
export type LoopCause = "code" | "env" | "contract" | "context";

export type LoopMark = {
  relation: LoopRelation | null;
  cause: LoopCause | null;
};

const RELATIONS = new Set<LoopRelation>(["same_loop", "new_evidence"]);
const CAUSES = new Set<LoopCause>(["code", "env", "contract", "context"]);

export function asRelation(value: string | null | undefined): LoopRelation | null {
  return value && RELATIONS.has(value as LoopRelation) ? (value as LoopRelation) : null;
}

export function asCause(value: string | null | undefined): LoopCause | null {
  return value && CAUSES.has(value as LoopCause) ? (value as LoopCause) : null;
}

/**
 * `new_evidence` lifts an earlier block. `same_loop` blocks even when a patch
 * might help: the same hypothesis will not. `env` and `contract` block when
 * the relation itself is unknown. `code` and `context` do not block.
 */
export function loopEffect(mark: LoopMark | null): "block" | "allow" {
  if (!mark) return "allow";
  if (mark.relation === "new_evidence") return "allow";
  if (mark.relation === "same_loop") return "block";
  if (mark.cause === "env" || mark.cause === "contract") return "block";
  return "allow";
}

export function loopWakeNote(mark: LoopMark | null, lang: "en" | "ru"): string | null {
  if (!mark || (!mark.relation && !mark.cause)) return null;
  const bits = [mark.relation, mark.cause].filter(Boolean).join("/");
  if (loopEffect(mark) === "block") {
    return lang === "en"
      ? `Loop mark ${bits}: the department lead must diagnose the history with job diagnose, fix the cause, then authorize one verified recovery. Ask the owner only for missing authority or changed requirements.`
      : `Стоп круга ${bits}: руководитель отдела разбирает историю через job diagnose, исправляет причину и разрешает одно проверенное восстановление. Владелец нужен только для недостающих полномочий или изменения требований.`;
  }
  return lang === "en"
    ? `Loop mark ${bits}: a new round is allowed.`
    : `Стоп круга ${bits}: новый круг можно открыть.`;
}
