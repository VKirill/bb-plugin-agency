import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WorkProfileView } from "../../shared/rpc-contract";
import { workProfileText } from "../../shared/work-profile-text";
import { Button, Collection, HintHeading, InfoHint, TextField } from "./shared";
import { tr, uiLocale } from "../i18n";

/**
 * Профили работ проекта: как здесь делают такой вид результата. Голос канала, стиль превью,
 * одобренные эталоны. Список приходит в каждый запуск проекта, полный текст — в ту задачу,
 * которой профиль назначен, поэтому владельцу не нужно повторять «пиши моим голосом».
 */

type Result<T> = { ok: true; value: T } | { ok: false };

type Sample = { label: string; ref: string; note: string };

type Draft = {
  key: string;
  title: string;
  triggers: string;
  body: string;
  samples: Sample[];
  acceptance: string;
  revision: number;
};

const EMPTY_SAMPLE: Sample = { label: "", ref: "", note: "" };
const EMPTY: Draft = { key: "", title: "", triggers: "", body: "", samples: [], acceptance: "", revision: 0 };

function toDraft(profile: WorkProfileView): Draft {
  return {
    key: profile.key,
    title: profile.title,
    triggers: profile.triggers.join(", "),
    body: profile.body,
    samples: profile.samples.map((sample) => ({ label: sample.label, ref: sample.ref, note: sample.note ?? "" })),
    acceptance: profile.acceptance,
    revision: profile.revision,
  };
}

function filledSamples(samples: readonly Sample[]) {
  return samples
    .filter((sample) => sample.label.trim() && sample.ref.trim())
    .map((sample) => ({ label: sample.label.trim(), ref: sample.ref.trim(), ...(sample.note.trim() ? { note: sample.note.trim() } : {}) }));
}

/** Строка эталона: название, ссылка и чем он хорош — три поля вместо формата с разделителями. */
function SampleRow({
  sample,
  onChange,
  onRemove,
}: {
  sample: Sample;
  onChange: (next: Sample) => void;
  onRemove: () => void;
}) {
  const field = "h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={tr("Название эталона")} className={`${field} w-40`} placeholder={tr("AG-14")} value={sample.label} onChange={(event) => onChange({ ...sample, label: event.target.value })} />
      <input aria-label={tr("Ссылка на эталон")} className={`${field} w-56`} placeholder={tr("job:AG-14")} value={sample.ref} onChange={(event) => onChange({ ...sample, ref: event.target.value })} />
      <input aria-label={tr("Чем хорош эталон")} className={`${field} flex-1`} placeholder={tr("40 000 просмотров")} value={sample.note} onChange={(event) => onChange({ ...sample, note: event.target.value })} />
      <Button size="sm" variant="ghost" className="h-9 px-2 text-xs" onClick={onRemove}>{tr("Убрать")}</Button>
    </div>
  );
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

  /** Ровно тот текст, который придёт сотруднику: правишь форму — видишь промпт. */
  const preview = useMemo(
    () =>
      draft && draft.title.trim() && draft.body.trim()
        ? workProfileText({ key: draft.key.trim() || "…", title: draft.title.trim(), body: draft.body, samples: filledSamples(draft.samples), acceptance: draft.acceptance })
        : null,
    [draft],
  );

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
        samples: filledSamples(draft.samples),
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
      setDraft(null);
      notice(tr("Профиль удалён."));
    } finally {
      setPending(false);
    }
  };

  if (!profiles) return <p className="text-sm text-muted-foreground">{tr("Загружаем профили работ…")}</p>;

  return (
    <div className="space-y-4" data-testid="work-profiles">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <HintHeading
          title="Профили работ"
          hint={<>
            <p>{tr("Как в этом проекте делают такой вид результата: голос канала, стиль превью, одобренные эталоны.")}</p>
            <p>{tr("Список профилей приходит в каждый запуск проекта. Руководитель ставит профиль подзадаче, и его полный текст видит исполнитель — напоминать про стиль не нужно.")}</p>
          </>}
        />
        {!draft && <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>{tr("Добавить профиль")}</Button>}
      </div>

      {profiles.length === 0 && !draft ? (
        <p className="max-w-prose text-sm text-muted-foreground">{tr("Профилей пока нет. Первый профиль имеет смысл завести для того, что делается регулярно: пост в канал, превью, письмо клиенту.")}</p>
      ) : profiles.length > 0 ? (
        <Collection
          columns={["Профиль", "Признаки", "Эталоны", "Изменён"]}
          rows={profiles.map((profile) => ({
            id: profile.key,
            name: (
              <span>
                <span className="block font-medium">{profile.title}</span>
                <span className="block font-mono text-xs text-muted-foreground">{profile.key}</span>
              </span>
            ),
            cells: [
              profile.triggers.join(", ") || "—",
              profile.samples.length ? String(profile.samples.length) : "—",
              new Date(profile.updatedAt).toLocaleDateString(uiLocale()),
            ],
            open: () => setDraft(toDraft(profile)),
          }))}
        />
      ) : null}

      {draft && (
        <section className="max-w-3xl space-y-4 rounded-lg border border-border bg-muted/20 p-5" aria-label={tr("Профиль работы")}>
          <h3 className="text-sm font-semibold">
            {draft.revision > 0 ? draft.title || draft.key : tr("Новый профиль работы")}
            {draft.revision > 0 && <span className="ml-2 font-normal text-xs text-muted-foreground">{tr("правка {count}", { count: draft.revision })}</span>}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Ключ" value={draft.key} onChange={(key) => setDraft({ ...draft, key })} hint="Латиницей: tg-post, zen-post, yt-thumbnail." maxLength={60} required />
            <TextField label="Название" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} placeholder="Пост в Telegram" maxLength={120} required />
          </div>
          <TextField label="Признаки" value={draft.triggers} onChange={(triggers) => setDraft({ ...draft, triggers })} placeholder="пост в телеграм, тг, пост в канал" hint="Через запятую: по этим словам руководитель узнаёт такую работу." />
          <TextField
            label="Как это делается"
            value={draft.body}
            onChange={(body) => setDraft({ ...draft, body })}
            multiline
            rows={8}
            hint="Голос, стиль, длина, что никогда. Пишите так, как объяснили бы новому человеку."
            required
          />

          <div className="space-y-2">
            <HintHeading
              level={3}
              title="Эталоны"
              hint={<p>{tr("Работы, которые вы одобрили: исполнитель держит эту планку. Ссылкой может быть ключ задачи, адрес поста или путь к файлу.")}</p>}
            />
            {draft.samples.map((sample, index) => (
              <SampleRow
                key={index}
                sample={sample}
                onChange={(next) => setDraft({ ...draft, samples: draft.samples.map((item, at) => (at === index ? next : item)) })}
                onRemove={() => setDraft({ ...draft, samples: draft.samples.filter((_, at) => at !== index) })}
              />
            ))}
            <Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, samples: [...draft.samples, { ...EMPTY_SAMPLE }] })}>{tr("Добавить эталон")}</Button>
          </div>

          <TextField label="Добавка к критерию приёмки" value={draft.acceptance} onChange={(acceptance) => setDraft({ ...draft, acceptance })} multiline rows={3} hint="Что проверяющий обязан проверить сверх критерия самой задачи." />

          {preview && (
            <details className="rounded-md border border-border bg-background p-3 text-sm">
              <summary className="cursor-pointer text-sm font-medium">{tr("Что увидит сотрудник")}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{preview}</pre>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={pending || !draft.key.trim() || !draft.title.trim() || !draft.body.trim()}>{tr("Сохранить профиль")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr("Отмена")}</Button>
            {draft.revision > 0 && (
              <Button size="sm" variant="ghost" className="ml-auto" disabled={pending} onClick={() => void remove(draft.key)}>{tr("Убрать профиль")}</Button>
            )}
          </div>
        </section>
      )}

      {profiles.length > 0 && !draft && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {tr("Профиль ставится задаче полем workProfileKey — это делает руководитель, когда видит подходящую работу.")}
          <InfoHint title="Как профиль попадает в работу">
            <p>{tr("Список профилей проекта приходит в каждый запуск: руководитель видит ключи и признаки.")}</p>
            <p>{tr("Полный текст профиля получает только та задача, которой он назначен, вместе с эталонами и добавкой к приёмке.")}</p>
          </InfoHint>
        </p>
      )}
    </div>
  );
}
