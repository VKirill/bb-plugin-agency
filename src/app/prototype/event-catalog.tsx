import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import type { PluginThreadEventName } from "@get-bb/plugin-sdk";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from "../../../components/ui/select";
import { tr } from "../i18n";

// Exhaustive against the installed SDK: a new/removed event requires catalog review.
export const bbEvents = {
 "thread.created": ["Чат агента создан", "Создана запись чата. Первое сообщение ещё может отсутствовать."],
 "thread.active": ["Агент начал работу", "Чат перешёл в активное состояние."],
 "thread.idle": ["Агент перешёл в ожидание", "Рабочий ход закончился. Это не означает, что задача выполнена или результат принят."],
 "thread.failed": ["Ошибка в чате агента", "Чат перешёл в состояние ошибки. Причина передаётся, если известна."],
 "thread.archived": ["Чат агента архивирован", "Чат помещён в архив, в том числе при архивации родительского чата."],
 "thread.unarchived": ["Чат агента восстановлен", "Чат возвращён из архива. Само восстановление не запускает агента."],
 "thread.deleted": ["Чат агента удалён", "Запись чата помечена удалённой."],
 "interaction.pending": ["Агент ожидает ответа или подтверждения", "Создан ожидающий взаимодействия запрос. Его тип и содержание доступны в данных события."],
 "message.queued": ["Сообщение поставлено в очередь", "Сообщение ожидает отправки. При изменении причины ожидания событие может повторяться."],
 "message.dispatched": ["Сообщение из очереди отправлено", "Условия ожидания сняты и сообщение передано на исполнение. Ход агента ещё может не начаться."],
 "message.cancelled": ["Сообщение в очереди отменено", "Сообщение удалено пользователем до отправки. Архивация чата даёт отдельное событие."],
 "turn.failed": ["Ход агента завершился ошибкой", "Ошибка конкретной попытки: идентификаторы, сведения провайдера, лимиты и номер попытки. Это не отдельная новая ошибка относительно thread.failed."],
 "experimental_thread.events": ["История чата обновилась", "Экспериментальный API: уведомление не чаще раза в секунду. Передаёт номер последнего события; содержание нужно читать отдельно."],
 "experimental_terminal.input": ["В терминал введена команда или текст", "Экспериментальный API терминала: принят реальный ввод пользователя. Сам текст ввода не передаётся; вывод терминала не вызывает событие."],
} satisfies Record<PluginThreadEventName, [string,string]>;
export const agencyEvents = {
 "question.created": ["Агент задал вопрос", "Планируется: зарегистрирован структурированный запрос, привязанный к задаче и запуску."],
 "question.answered": ["Пользователь ответил", "Планируется: BB подтвердил принятие ответа на конкретный запрос."],
 "artifact.updated": ["Создана новая версия файла", "Планируется: сохранена новая версия результата. Ранее принятая версия не заменяется молча."],
 "job.created": ["Создана задача", "Планируемое событие Агентства: задача добавлена в очередь."],
 "job.ready_for_review": ["Результат готов к проверке", "Планируемое событие Агентства: исполнитель приложил результат и передал его на проверку."],
 "review.accepted": ["Результат принят", "Планируемое событие Агентства: проверяющий принял конкретную версию результата."],
 "review.rejected": ["Результат возвращён на доработку", "Планируемое событие Агентства: проверяющий оставил замечания к результату."],
 "dependencies.completed": ["Зависимые этапы завершены", "Планируемое событие Агентства: выполнены условия для продолжения следующего этапа."],
 "research.delivered": ["Исследование передано", "Пример пользовательского уведомления от исследовательского workflow."],
};
const telegramEvents:Record<string,string[]>={"telegram.notification.delivered":["Уведомление доставлено в Telegram","Квитанция доставки из API Telegram Projects. Обработка диспетчером планируется."]};
const events: Record<string, string[]> = {...bbEvents,...agencyEvents,...telegramEvents};
export function EventLabel({topic}:{topic:string}) {
 return <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 text-sm"><span>{tr(events[topic]?.[0]||"Пользовательское событие")}</span><span className="break-all text-xs font-normal text-muted-foreground">({topic})</span></span>;
}
export function EventPicker({value,onChange,label="Слушать событие"}:{value:string;onChange:(topic:string)=>void;label?:string}) {
 const rpc=useRpc<typeof rpcContract>();const[extra,setExtra]=useState<string[]>([]);
 useEffect(()=>{let live=true;rpc.call("telegramInfo").then(info=>{if(live)setExtra(info.capabilities?.events.filter(e=>e in telegramEvents)||[]);},()=>{});return()=>{live=false;};},[rpc]);
 const groups = [
  {title:"Агенты и сообщения · API BB",items:Object.keys(bbEvents).filter(k=>!k.startsWith("experimental_"))},
  {title:"История и терминал · экспериментальный API BB",items:Object.keys(bbEvents).filter(k=>k.startsWith("experimental_"))},
  {title:"Задачи и workflow · события Агентства, планируются",items:Object.keys(agencyEvents)},
  ...(extra.length?[{title:"Telegram Projects · подключённый плагин",items:extra}]:[]),
 ];
 return <div className="space-y-3"><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={tr(label)} className="h-auto min-h-9 text-left [&>span]:line-clamp-none [&>span]:whitespace-normal"><SelectValue><EventLabel topic={value}/></SelectValue></SelectTrigger><SelectContent className="max-w-[calc(100vw-2rem)]">{!events[value]&&<SelectItem value={value}><EventLabel topic={value}/></SelectItem>}{groups.map(group=><SelectGroup key={group.title}><SelectLabel className="max-w-full whitespace-normal text-xs text-muted-foreground">{tr(group.title)}</SelectLabel>{group.items.map(topic=><SelectItem key={topic} value={topic} textValue={`${tr(events[topic][0])} ${topic}`} className="py-2"><EventLabel topic={topic}/></SelectItem>)}</SelectGroup>)}</SelectContent></Select><p className="text-sm text-muted-foreground">{tr(events[value]?.[1]||"Контракт этого уведомления определяется его отправителем.")}</p><p className="text-xs text-muted-foreground">{tr("API BB: {bbCount} событий · Агентство: {agencyCount} примеров. В прототипе выбор не включает подписку и не запускает агентов.",{bbCount:Object.keys(bbEvents).length,agencyCount:Object.keys(agencyEvents).length})}</p></div>;
}
