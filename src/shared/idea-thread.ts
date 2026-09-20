/** First user message seeded into the official new-thread composer. */
export function ideaThreadComposerPrompt(idea: { title: string; body: string; relativePath: string }): string {
  return `# ${idea.title}\n\n${idea.body.trim()}\n\nФайл: \`${idea.relativePath}\`\n`;
}

/** One-shot agent-only note so the new chat knows this is an Agency idea, not a job. */
export function ideaThreadAgentBrief(idea: { id: string; title: string; relativePath: string }): string {
  return [
    "Это обсуждение записи из склада идей Агентства.",
    `id: ${idea.id}`,
    `название: ${idea.title}`,
    `файл: ${idea.relativePath}`,
    "Не превращай идею в поручение и не меняй статус, пока владелец не попросил.",
  ].join("\n");
}
