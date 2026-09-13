import { Choice, Field, TextField } from './shared';
export const schedulePresets = [
 {value:'0 10 * * 1',label:'Каждый понедельник, 10:00'},
 {value:'0 9 * * 1-5',label:'По будням, 09:00'},
 {value:'0 10 * * *',label:'Каждый день, 10:00'},
 {value:'0 * * * *',label:'Каждый час'},
];
export function scheduleName(cron:string) { return schedulePresets.find(p=>p.value===cron)?.label||'Своё расписание'; }
export function ScheduleEditor({cron,timezone,onChange}:{cron:string;timezone:string;onChange:(patch:{cron?:string;timezone?:string})=>void}) {
 return <div className="space-y-4"><Field label="Повторять"><Choice label="Повторять" value={schedulePresets.some(p=>p.value===cron)?cron:'custom'} onChange={value=>onChange({cron:value==='custom'?'30 10 * * *':value})} options={[...schedulePresets,{value:'custom',label:'Своё расписание (cron)'}]}/></Field><Field label="Часовой пояс"><Choice label="Часовой пояс" value={timezone} onChange={timezone=>onChange({timezone})} options={['Europe/Madrid','Europe/Moscow','UTC']}/></Field><details className="rounded-md border border-border p-3" open={!schedulePresets.some(p=>p.value===cron)}><summary className="cursor-pointer text-sm font-medium">Изменить cron-выражение</summary><div className="mt-3"><TextField label="Cron — минуты, часы, день месяца, месяц, день недели" value={cron} onChange={cron=>onChange({cron})}/><p className="mt-2 text-xs text-muted-foreground">Ровно пять полей, без секунд. Ниже показано, когда сработает правило.</p></div></details></div>;
}
