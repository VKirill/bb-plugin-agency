import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WorkProfileView } from "../../shared/rpc-contract";
import { Button, HintHeading, TextField } from "./shared";
import { tr } from "../i18n";

/**
 * Профили работ проекта: как здесь делают такой вид результата. Голос канала, стиль превью,
 * одобренные эталоны. Список приходит в каждый запуск проекта, полный текст — в ту задачу,
 * которой профиль назначен, поэтому владельцу не нужно повторять «пиши моим голосом».
 */

type Result<T> = { ok: true; value: T } | { ok: false };

type Draft = {
  key: string;
  title: string;
  triggers: string;
  body: string;
  samples: string;
  acceptance: string;
  revision: number;
};

const EMPTY: Draft = { key: "", title: "", triggers: "", body: "", samples: "", acceptance: "", revision: 0 };

function toDraft(profile: WorkProfileView): Draft {
  return {
    key: profile.key,
    title: profile.title,
    triggers: profile.triggers.join(", "),
    body: profile.body,
    samples: profile.samples.map((sample) => [sample.label, sample.ref, sample.note].filter(Boolean).join(" | ")).join("\n"),
    acceptance: profile.acceptance,
    revision: profile.revision,
  };
}

/** «AG-14 | job:AG-14 | 40 000 просмотров» — по строке на эталон. */
function parseSamples(text: string): { label: string; ref: string; note?: string }[] {
  return text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0] && parts[1])
    .map((parts) => ({ label: parts[0]!, ref: parts[1]!, ...(parts[2] ? { note: parts[2] } : {}) }));
}

export function WorkProfilesPanel({ bbProjectId, notice }: { bbProjectId: string; notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [profiles, setProfiles] = useState<WorkProfileView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);

  const load = async () => {
    const result = (await rpc.call("listWorkProfiles", { bbProjectId })) as Result<WorkProfileView[]>;
    setProfiles(result.ok ? result.value : []);
  };

  useEffect(() => {
    let live = true;
    void Promise.resolve(rpc.call("listWorkProfiles", { bbProjectId })).then(
      (result) => { if (live) setProfiles((result as Result<WorkProfileView[]>).ok ? (result as { value: WorkProfileView[] }).value : []); },
      () => { if (live) setProfiles([]); },
    );
    return () => { live = false; };
  }, [rpc, bbProjectId]);

  const known = useMemo(() => new Set((profiles ?? []).map((profile) => profile.key)), [profiles]);

  const save = async () => {
    if (!draft || pending) return;
    setPending(true);
    try {
      const result = (await rpc.call("saveWorkProfile", {
        bbProjectId,
        key: draft.key,
        expectedRevision: draft.revision,
        title: draft.title,
        triggers: draft.triggers.split(",").map((item) => item.trim()).filter(Boolean),
        body: draft.body,
        samples: parseSamples(draft.samples),
        acceptance: draft.acceptance,
      })) as Result<WorkProfileView>;
      if (!result.ok) {
        notice(tr("Не удалось сохранить профиль. Проверьте ключ и текст."));
        return;
      }
      await load();
      setDraft(null);
      notice(tr("Профиль сохранён. Он придёт в следующий запуск задач этого проекта."));
    } catch {
      notice(tr("Не удалось сохранить профиль. Проверьте ключ и текст."));
    } finally {
      setPending(false);
    }
  };

  const remove = async (key: string) => {
    setPending(true);
    try {
      await rpc.call("deleteWorkProfile", { bbProjectId, key });
      await load();
      notice(tr("Профиль удалён."));
    } finally {
      setPending(false);
    }
  };

  if (!profiles) return <p className="text-sm text-muted-foreground">{tr("Загружаем профили работ…")}</p>;

  return (
    <div className="space-y-4" data-testid="work-profiles">
      <HintHeading
        title="Профили работ"
        hint={<>
          <p>{tr("Как в этом проекте делают такой вид результата: голос канала, стиль превью, одобренные эталоны.")}</p>
          <p>{tr("Список профилей приходит в каждый запуск проекта. Руководитель ставит профиль подзадаче, и его полный текст видит исполнитель — напоминать про стиль не нужно.")}</p>
        </>}
      />

      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("Профилей пока нет. Первый профиль имеет смысл завести для того, что делается регулярно: пост в канал, превью, письмо клиенту.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{tr("Ключ")}</th>
                <th className="px-3 py-2 font-medium">{tr("Название")}</th>
                <th className="px-3 py-2 font-medium">{tr("Признаки")}</th>
                <th className="px-3 py-2 font-medium">{tr("Эталоны")}</th>
                <th className="px-3 py-2 text-right font-medium"><span className="sr-only">{tr("Строка")}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {profiles.map((profile) => (
                <tr key={profile.key} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs">{profile.key}</td>
                  <td className="px-3 py-2">{profile.title}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{profile.triggers.join(", ") || "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{profile.samples.length || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDraft(toDraft(profile))}>{tr("Изменить")}</Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={pending} onClick={() => void remove(profile.key)}>{tr("Убрать")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft ? (
        <section className="space-y-3 rounded-lg border border-border p-3">
          <TextField label="Ключ" value={draft.key} onChange={(key) => setDraft({ ...draft, key })} hint="Короткое имя латиницей: tg-post, zen-post, yt-thumbnail." maxLength={60} required />
          <TextField label="Название" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} maxLength={120} required />
          <TextField label="Признаки" value={draft.triggers} onChange={(triggers) => setDraft({ ...draft, triggers })} hint="Через запятую: по этим словам руководитель узнаёт такую работу." />
          <TextField
            label="Как это делается"
            value={draft.body}
            onChange={(body) => setDraft({ ...draft, body })}
            multiline
            rows={10}
            hint="Голос, стиль, длина, что никогда. Пишите так, как объяснили бы новому человеку."
            required
          />
          <TextField
            label="Эталоны"
            value={draft.samples}
            onChange={(samples) => setDraft({ ...draft, samples })}
            multiline
            rows={4}
            hint="По строке: название | ссылка | чем хорош. Например «AG-14 | job:AG-14 | 40 000 просмотров»."
          />
          <TextField label="Добавка к критерию приёмки" value={draft.acceptance} onChange={(acceptance) => setDraft({ ...draft, acceptance })} multiline rows={3} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void save()} disabled={pending || !draft.key.trim() || !draft.title.trim() || !draft.body.trim()}>{tr("Сохранить профиль")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
          </div>
        </section>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setDraft({ ...EMPTY })} disabled={pending}>{tr("Добавить профиль")}</Button>
      )}

      {known.size > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr("В задаче профиль ставится полем workProfileKey: «bb agency job update» с ключом профиля. Руководитель делает это сам, когда видит подходящую работу.")}
        </p>
      )}
    </div>
  );
}
