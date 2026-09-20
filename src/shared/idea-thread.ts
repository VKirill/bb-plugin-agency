/** Absolute path on the binding host, or the binding-root relative path if the file is not placed yet. */
export function ideaFileOpenPath(idea: { projectPath?: string | null; relativePath: string }): string {
  const absolute = idea.projectPath?.trim();
  return absolute || idea.relativePath;
}

/** First user message seeded into the official new-thread composer. */
export function ideaThreadComposerPrompt(idea: { title: string; body: string; projectPath?: string | null; relativePath: string }): string {
  return `# ${idea.title}\n\n${idea.body.trim()}\n\nФайл: \`${ideaFileOpenPath(idea)}\`\n`;
}

/** One-shot agent-only note so the new chat knows this is an Agency idea, not a job. */
export function ideaThreadAgentBrief(idea: { id: string; title: string; projectPath?: string | null; relativePath: string }): string {
  return [
    "Это обсуждение записи из склада идей Агентства.",
    `id: ${idea.id}`,
    `название: ${idea.title}`,
    `файл: ${ideaFileOpenPath(idea)}`,
    "Не превращай идею в поручение и не меняй статус, пока владелец не попросил.",
  ].join("\n");
}
