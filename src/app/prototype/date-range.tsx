import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Button } from "../../../components/ui/button";
import {
  EMPTY_RANGE,
  formatMonth,
  formatRange,
  inRange,
  isoDay,
  monthGrid,
  monthOf,
  pickDay,
  sameMonth,
  shiftMonth,
  type DateRange,
} from "../data/date-range";
import { tr } from "../i18n";

/** One calendar for both ends: click the start, click the end. Presets set the usual windows. */

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PRESETS = [
  { days: 7, label: "7 дней" },
  { days: 30, label: "30 дней" },
  { days: 90, label: "90 дней" },
];

function presetRange(days: number): DateRange {
  const today = new Date();
  const from = new Date(today.getTime());
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { fromDate: isoDay(from), toDate: isoDay(today) };
}

export function DateRangePicker({
  range,
  onChange,
  label = "Период",
}: {
  range: DateRange;
  onChange: (next: DateRange) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthOf(range.toDate || range.fromDate));
  const today = isoDay(new Date());

  const choose = (day: string) => {
    const next = pickDay(range, day);
    onChange(next);
    // The range is complete: the owner has said everything, close the calendar.
    if (next.fromDate && next.toDate) setOpen(false);
  };

  return (
    <label className="block text-xs text-muted-foreground">
      {tr(label)}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={tr("Выбрать период")}
            data-testid="usage-range-trigger"
            className="mt-1 flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          >
            <span className="truncate">{formatRange(range, tr("Весь период"))}</span>
            <span aria-hidden className="text-muted-foreground">▾</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={tr("Предыдущий месяц")} onClick={() => setView(shiftMonth(view, -1))}>←</Button>
            <span className="text-sm font-medium">{formatMonth(view)}</span>
            <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={tr("Следующий месяц")} onClick={() => setView(shiftMonth(view, 1))}>→</Button>
          </div>

          <table className="mt-2 w-full table-fixed border-separate border-spacing-0.5 text-center text-xs">
            <thead className="text-muted-foreground">
              <tr>{WEEKDAYS.map((day) => <th key={day} className="py-1 font-normal">{tr(day)}</th>)}</tr>
            </thead>
            <tbody>
              {monthGrid(view.year, view.month).map((week) => (
                <tr key={week[0]}>
                  {week.map((day) => {
                    const edge = day === range.fromDate || day === range.toDate;
                    const between = inRange(day, range);
                    const outside = !sameMonth(day, view);
                    // One background class per state: two of them on one button is a coin toss.
                    const paint = edge
                      ? "bg-foreground font-medium text-background"
                      : between
                        ? "bg-muted text-foreground hover:bg-muted"
                        : outside
                          ? "bg-transparent text-muted-foreground/60 hover:bg-muted/60"
                          : "bg-transparent hover:bg-muted";
                    return (
                      <td key={day} className="p-0">
                        <button
                          type="button"
                          aria-label={day}
                          aria-pressed={edge || between}
                          onClick={() => choose(day)}
                          className={`h-7 w-full appearance-none rounded border-0 text-xs tabular-nums ${paint}${day === today && !edge ? " ring-1 ring-border" : ""}`}
                        >
                          {Number(day.slice(8))}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border pt-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.days}
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  const next = presetRange(preset.days);
                  onChange(next);
                  setView(monthOf(next.toDate));
                  setOpen(false);
                }}
              >
                {tr(preset.label)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => {
                onChange({ ...EMPTY_RANGE });
                setOpen(false);
              }}
            >
              {tr("Весь период")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </label>
  );
}
