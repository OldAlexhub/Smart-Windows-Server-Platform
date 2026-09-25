/** Small, dependency-free five-field cron parser (minute hour day-of-month month day-of-week). */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

interface Field {
  values: Set<number>;
  any: boolean;
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

function number(value: string, names: Record<string, number>, min: number, max: number, dayOfWeek: boolean): number {
  const named = names[value.toLowerCase()];
  const n = named ?? Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${value}" is outside ${min}–${max}.`);
  return dayOfWeek && n === 7 ? 0 : n;
}

function field(text: string, min: number, max: number, names: Record<string, number> = {}, dayOfWeek = false): Field {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (!item) throw new Error("Empty list item.");
    const parts = item.split("/");
    if (parts.length > 2) throw new Error(`"${item}" has too many / characters.`);
    const base = parts[0]!;
    const step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${item}" needs a positive whole-number step.`);
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`"${item}" isn't a valid range.`);
      const rawStart = names[range[0]!.toLowerCase()] ?? Number(range[0]);
      const rawEnd = names[range[1]!.toLowerCase()] ?? Number(range[1]);
      if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < min || rawStart > max || rawEnd < min || rawEnd > max || rawStart > rawEnd) {
        throw new Error(`"${item}" isn't a valid ${min}–${max} range.`);
      }
      start = rawStart;
      end = rawEnd;
    } else {
      const n = number(base, names, min, max, dayOfWeek);
      start = dayOfWeek && n === 0 && base === "7" ? 7 : n;
      end = start;
    }
    for (let n = start; n <= end; n += step) values.add(dayOfWeek && n === 7 ? 0 : n);
  }
  if (!values.size) throw new Error("The field doesn't select any values.");
  // Cron treats an unrestricted day-of-month/day-of-week specially. Recognize equivalent
  // spellings such as */1 too, otherwise `*/1 * MON` would incorrectly run every day.
  const distinctRangeSize = dayOfWeek ? max - min : max - min + 1;
  const any = values.size === distinctRangeSize;
  return { values, any };
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Use five fields: minute hour day-of-month month day-of-week.");
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    dayOfMonth: field(parts[2]!, 1, 31),
    month: field(parts[3]!, 1, 12, MONTHS),
    dayOfWeek: field(parts[4]!, 0, 7, DAYS, true),
  };
}

export function cronProblem(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (e) {
    return `Invalid cron schedule: ${(e as Error).message}`;
  }
}

export function cronMatches(date: Date, expression: string | ParsedCron): boolean {
  const c = typeof expression === "string" ? parseCron(expression) : expression;
  if (!c.minute.values.has(date.getMinutes()) || !c.hour.values.has(date.getHours()) || !c.month.values.has(date.getMonth() + 1)) return false;
  const dom = c.dayOfMonth.values.has(date.getDate());
  const dow = c.dayOfWeek.values.has(date.getDay());
  // Standard cron behavior: when both fields are restricted, either may match.
  const day = c.dayOfMonth.any && c.dayOfWeek.any ? true : c.dayOfMonth.any ? dow : c.dayOfWeek.any ? dom : dom || dow;
  return day;
}

/** Latest matching local-time minute at or before `now`, but strictly after `after`. */
export function previousCronSlot(expression: string, now: Date, after?: Date): Date | null {
  const parsed = parseCron(expression);
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  const floor = after?.getTime() ?? cursor.getTime() - 5 * 366 * 24 * 60 * 60_000;
  for (; cursor.getTime() > floor; cursor.setMinutes(cursor.getMinutes() - 1)) {
    if (cronMatches(cursor, parsed)) return new Date(cursor);
  }
  return null;
}
