/**
 * QC report → accept | rework. Unknown defaults to accept: the factory
 * must not stall a station because the reviewer forgot the verdict line.
 */

export type ReviewVerdict = "accept" | "rework";

const VERDICT_LINE =
  /(?:вердикт|verdict)\s*[:：]?\s*(принять|accept|доработать|rework|return)/i;
const REWORK_WORD = /доработать|rework|на доработку/i;
const ACCEPT_WORD = /принять|accept/i;

export function parseReviewVerdict(text: string): ReviewVerdict {
  const head = text.slice(0, 8000);
  const line = VERDICT_LINE.exec(head);
  if (line) {
    const token = line[1]!.toLowerCase();
    return token === "доработать" || token === "rework" || token === "return" ? "rework" : "accept";
  }
  if (REWORK_WORD.test(head) && !ACCEPT_WORD.test(head)) return "rework";
  return "accept";
}
