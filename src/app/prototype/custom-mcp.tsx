import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui/dialog";
import { Switch } from "../../../components/ui/switch";
import { Button, Textarea, PageHead } from "./shared";
import { parseMcpImport, mcpExample, mcpTransport, type CustomMcp } from "./mcp-config";
import { tr } from "../i18n";

export function CustomMcpEditor({items, reservedNames, onChange, disabled=false}: {items:CustomMcp[];reservedNames:string[];onChange:(items:CustomMcp[])=>void;disabled?:boolean}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string|null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CustomMcp[]|null>(null);
  const [error, setError] = useState('');
  const changeText = (value:string) => { setText(value); setPreview(null); setError(''); };
  const close = () => { setOpen(false); changeText(''); setEditing(null); };
  const edit = (item?:CustomMcp) => {
    setEditing(item?.name || null);
    changeText(item ? JSON.stringify({mcpServers:{[item.name]:item.config}},null,2) : '');
    setOpen(true);
  };
  const validate = () => {
    try {
      const parsed = parseMcpImport(text,[...reservedNames,...items.filter(i=>i.name!==editing).map(i=>i.name)]);
      if(editing && parsed.length!==1) throw new Error(tr('При редактировании оставьте один сервер. Для нескольких используйте добавление.'));
      setPreview(parsed); setError('');
    } catch(e) { setPreview(null); setError(e instanceof Error ? e.message : tr('Не удалось проверить JSON.')); }
  };
  return <section className="space-y-3">
    <PageHead level={2} title="Собственные MCP" description={disabled?"Свои MCP в версии профиля не хранятся — только идентификаторы из каталога.":"Дополнительные подключения только для этого сотрудника."}>{!disabled&&<Button variant="outline" onClick={()=>edit()}>{tr("Добавить MCP через JSON")}</Button>}</PageHead>
    {items.length>0 && <div className="divide-y divide-border rounded-lg border border-border">{items.map(item=><div key={item.name} className="flex flex-wrap items-center gap-3 px-3 py-3">
      <Switch aria-label={tr("Использовать {name}", { name: item.name })} checked={item.enabled} disabled={disabled} onCheckedChange={enabled=>onChange(items.map(i=>i.name===item.name?{...i,enabled}:i))}/>
      <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{mcpTransport(item.config)} · {item.enabled?tr('Выбран'):tr('Выключен')} · {tr('Не подключён')}</p></div>
      {!disabled&&<div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={tr("Изменить {name}", { name: item.name })} onClick={()=>edit(item)}>{tr("Изменить")}</Button><Button size="sm" variant="ghost" aria-label={tr("Удалить {name}", { name: item.name })} onClick={()=>onChange(items.filter(i=>i.name!==item.name))}>{tr("Удалить")}</Button></div>}
    </div>)}</div>}
    <p className="text-xs text-muted-foreground">{tr("JSON хранится в примере до обновления страницы. Серверы не запускаются и доступы CLI не меняются.")}</p>
    <Dialog open={open} onOpenChange={value=>{if(!value)close();}}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{editing?tr('Изменить MCP'):tr('Добавить MCP через JSON')}</DialogTitle><DialogDescription>{editing?tr("Измените конфигурацию одного сервера."):tr("Вставьте объект mcpServers. Можно добавить несколько серверов.")} {tr("Проверка формата не проверяет соединение.")}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={()=>changeText(mcpExample())}>{tr("Пример HTTP")}</Button><Button size="sm" variant="outline" onClick={()=>changeText(mcpExample(true))}>{tr("Пример stdio")}</Button></div>
      <div className="space-y-2"><label htmlFor="agency-mcp-json" className="text-sm font-medium">{tr("Конфигурация JSON")}</label><Textarea id="agency-mcp-json" autoFocus value={text} onChange={e=>changeText(e.target.value)} spellCheck={false} autoComplete="off" maxLength={65537} placeholder={'{ "mcpServers": { … } }'} className="min-h-56 font-mono text-xs" aria-invalid={Boolean(error)} aria-describedby="agency-mcp-help"/><p id="agency-mcp-help" className="text-xs text-muted-foreground">{tr("Вместо ключей используйте {secret}. Не вставляйте секреты в URL или аргументы. Ссылки в этом прототипе не разрешаются.", { secret: '${SECRET_NAME}' })}</p></div>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview&&<section aria-live="polite" className="rounded-lg border border-border bg-muted/30 p-3"><h3 className="mb-2 text-sm font-medium">{tr("Формат проверен · {count} MCP", { count: preview.length })}</h3>{preview.map(item=><div key={item.name} className="flex flex-wrap justify-between gap-2 py-1 text-sm"><span className="break-all">{item.name}</span><span className="text-xs text-muted-foreground">{mcpTransport(item.config)} · {editing?tr('Изменение'):tr('Добавление')}</span></div>)}</section>}
      <DialogFooter className="gap-2"><Button variant="ghost" onClick={close}>{tr("Отмена")}</Button><Button variant="outline" disabled={!text.trim()} onClick={validate}>{tr("Проверить JSON")}</Button><Button disabled={!preview} onClick={()=>{if(!preview)return; const previous=items.find(i=>i.name===editing);onChange(editing?items.map(i=>i.name===editing?{...preview[0],enabled:previous?.enabled??true}:i):[...items,...preview]);close();}}>{editing?tr('Сохранить изменения'):tr('Добавить в профиль')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
