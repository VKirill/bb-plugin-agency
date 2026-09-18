import type { KnowledgeItem } from "./store";

/**
 * Кто принимает и убирает запись знаний. Владелец — любую; руководитель отдела — только записи
 * своего отдела и только те виды, что отдел пишет о своей работе: урок, процедуру, справку.
 *
 * Правило отдельно от RPC, потому что это решение о доверии, а не о транспорте: в нём легко
 * ошибиться, и оно проверяется тестом на всех комбинациях.
 */

export type KnowledgeRefusal = { code: "not_found" | "forbidden"; message: string };

/** Виды, которые отдел решает сам: остальное (регламент, запрет) остаётся за владельцем. */
export const LEAD_DECIDABLE_KINDS = ["lesson", "procedure", "reference"] as const;

export function knowledgeDecisionRefusal(
  callerAgentId: string | null,
  item: KnowledgeItem | null,
  leadAgentId: string | null,
): KnowledgeRefusal | null {
  // Владелец решает из интерфейса: у его вызова нет треда сотрудника.
  if (!callerAgentId) return null;
  if (!item) return { code: "not_found", message: "knowledge not found" };
  if (item.scopeKind !== "department" || !item.scopeId) {
    return { code: "forbidden", message: "Знания проекта и всего Агентства принимает владелец." };
  }
  if (!leadAgentId || leadAgentId !== callerAgentId) {
    return { code: "forbidden", message: "Записи отдела принимает его руководитель или владелец." };
  }
  if (!(LEAD_DECIDABLE_KINDS as readonly string[]).includes(item.kind)) {
    return { code: "forbidden", message: "Руководитель принимает уроки, процедуры и справки; остальное решает владелец." };
  }
  return null;
}
