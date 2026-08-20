export type HolidayReligion = 'christian' | 'jewish' | 'muslim' | 'hindu';

export interface CalendarDefaultsSettings {
  usPublicEnabled: boolean;
  observancesEnabled: boolean;
  religions: HolidayReligion[];
}

export const DEFAULT_CALENDAR_DEFAULTS_SETTINGS: CalendarDefaultsSettings = {
  usPublicEnabled: true,
  observancesEnabled: false,
  religions: [],
};

export const HOLIDAY_RELIGION_LABELS: Record<HolidayReligion, string> = {
  christian: 'Christian',
  jewish: 'Jewish',
  muslim: 'Muslim',
  hindu: 'Hindu',
};

export const HOLIDAY_RELIGIONS: HolidayReligion[] = ['christian', 'jewish', 'muslim', 'hindu'];

export const CALENDAR_DEFAULTS_STORAGE_KEY_PREFIX = 'calendar-defaults:';
export const getCalendarDefaultsStorageKey = (userId: string) => `${CALENDAR_DEFAULTS_STORAGE_KEY_PREFIX}${userId}`;

export const normalizeCalendarDefaultsSettings = (raw: unknown): CalendarDefaultsSettings => {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_CALENDAR_DEFAULTS_SETTINGS;
  }

  const parsed = raw as Partial<CalendarDefaultsSettings>;
  const religions = Array.isArray(parsed.religions)
    ? parsed.religions.filter((religion): religion is HolidayReligion => HOLIDAY_RELIGIONS.includes(religion as HolidayReligion))
    : [];

  return {
    usPublicEnabled: parsed.usPublicEnabled !== false,
    observancesEnabled: parsed.observancesEnabled === true,
    religions,
  };
};

export interface HolidayEntry {
  id: string;
  name: string;
  date: Date;
  icon: string;
  color: string;
  category: 'us-public' | HolidayReligion | 'observance';
}

export const US_PUBLIC_HOLIDAY_COLOR = '#1E3A8A';
export const US_PUBLIC_HOLIDAY_ICON = '🇺🇸';
export const RELIGIOUS_HOLIDAY_FILTER_COLOR = '#7C2D92';
export const RELIGIOUS_HOLIDAY_FILTER_ICON = '🙏';
export const OBSERVANCE_HOLIDAY_COLOR = '#4338CA';
export const OBSERVANCE_HOLIDAY_FILTER_ICON = '🌟';

const RELIGION_COLORS: Record<HolidayReligion, string> = {
  christian: '#7C2D92',
  jewish: '#1D4ED8',
  muslim: '#0F766E',
  hindu: '#EA580C',
};

const RELIGION_ICONS: Record<HolidayReligion, string> = {
  christian: '✝️',
  jewish: '✡️',
  muslim: '☪️',
  hindu: '🕉️',
};

// --- Date helpers -----------------------------------------------------

const nthWeekdayOfMonth = (year: number, month: number, weekday: number, occurrence: number): Date => {
  const first = new Date(year, month, 1);
  const day = 1 + ((weekday - first.getDay() + 7) % 7) + (occurrence - 1) * 7;
  return new Date(year, month, day);
};

const lastWeekdayOfMonth = (year: number, month: number, weekday: number): Date => {
  const last = new Date(year, month + 1, 0);
  const day = last.getDate() - ((last.getDay() - weekday + 7) % 7);
  return new Date(year, month, day);
};

// Federal "observed" rule: Saturday holidays are observed the preceding Friday,
// Sunday holidays are observed the following Monday.
const observedFederalHoliday = (date: Date): Date => {
  const weekday = date.getDay();
  if (weekday === 6) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  }
  if (weekday === 0) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  }
  return date;
};

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for Easter Sunday.
const getEasterSunday = (year: number): Date => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
};

const addDays = (date: Date, days: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

// --- US public holidays (rule-based, accurate for any year) ----------

export const getUsPublicHolidaysForYear = (year: number): HolidayEntry[] => {
  const entries: Array<{ key: string; name: string; date: Date; icon: string }> = [
    { key: 'new-years-day', name: "New Year's Day", date: observedFederalHoliday(new Date(year, 0, 1)), icon: '🎆' },
    { key: 'mlk-day', name: 'Martin Luther King Jr. Day', date: nthWeekdayOfMonth(year, 0, 1, 3), icon: '✊' },
    { key: 'presidents-day', name: "Presidents' Day", date: nthWeekdayOfMonth(year, 1, 1, 3), icon: '🏛️' },
    { key: 'memorial-day', name: 'Memorial Day', date: lastWeekdayOfMonth(year, 4, 1), icon: '🎖️' },
    { key: 'juneteenth', name: 'Juneteenth', date: observedFederalHoliday(new Date(year, 5, 19)), icon: '🕊️' },
    { key: 'independence-day', name: 'Independence Day', date: observedFederalHoliday(new Date(year, 6, 4)), icon: '🇺🇸' },
    { key: 'labor-day', name: 'Labor Day', date: nthWeekdayOfMonth(year, 8, 1, 1), icon: '🛠️' },
    { key: 'columbus-day', name: 'Columbus Day', date: nthWeekdayOfMonth(year, 9, 1, 2), icon: '⛵' },
    { key: 'veterans-day', name: 'Veterans Day', date: observedFederalHoliday(new Date(year, 10, 11)), icon: '🎗️' },
    { key: 'thanksgiving', name: 'Thanksgiving Day', date: nthWeekdayOfMonth(year, 10, 4, 4), icon: '🦃' },
    { key: 'christmas', name: 'Christmas Day', date: observedFederalHoliday(new Date(year, 11, 25)), icon: '🎄' },
  ];

  return entries.map((entry) => ({
    id: `us-public-${entry.key}-${year}`,
    name: entry.name,
    date: entry.date,
    icon: entry.icon,
    color: US_PUBLIC_HOLIDAY_COLOR,
    category: 'us-public' as const,
  }));
};

// --- Observances (rule-based where possible; equinoxes/solstices use
// commonly published approximate calendar dates rather than a full
// astronomical ephemeris, so they can be off by a day in either direction
// depending on year and time zone) ------------------------------------

export const getObservanceHolidaysForYear = (year: number): HolidayEntry[] => {
  const laborDay = nthWeekdayOfMonth(year, 8, 1, 1);

  const entries: Array<{ key: string; name: string; date: Date; icon: string }> = [
    { key: 'groundhog-day', name: 'Groundhog Day', date: new Date(year, 1, 2), icon: '🦫' },
    { key: 'valentines-day', name: "Valentine's Day", date: new Date(year, 1, 14), icon: '💘' },
    { key: 'dst-start', name: 'Daylight Saving Time Begins', date: nthWeekdayOfMonth(year, 2, 0, 2), icon: '⏰' },
    { key: 'st-patricks-day', name: "St. Patrick's Day", date: new Date(year, 2, 17), icon: '🍀' },
    { key: 'spring-equinox', name: 'First Day of Spring', date: new Date(year, 2, 20), icon: '🌸' },
    { key: 'april-fools-day', name: "April Fools' Day", date: new Date(year, 3, 1), icon: '🤡' },
    { key: 'sibling-day', name: 'Sibling Day', date: new Date(year, 3, 10), icon: '👫' },
    { key: 'earth-day', name: 'Earth Day', date: new Date(year, 3, 22), icon: '🌍' },
    { key: 'may-day', name: 'May Day', date: new Date(year, 4, 1), icon: '🌷' },
    { key: 'cinco-de-mayo', name: 'Cinco de Mayo', date: new Date(year, 4, 5), icon: '🇲🇽' },
    { key: 'mothers-day', name: "Mother's Day", date: nthWeekdayOfMonth(year, 4, 0, 2), icon: '💐' },
    { key: 'fathers-day', name: "Father's Day", date: nthWeekdayOfMonth(year, 5, 0, 3), icon: '👔' },
    { key: 'flag-day', name: 'Flag Day', date: new Date(year, 5, 14), icon: '🚩' },
    { key: 'summer-solstice', name: 'First Day of Summer', date: new Date(year, 5, 20), icon: '☀️' },
    { key: 'friendship-day', name: 'Friendship Day', date: nthWeekdayOfMonth(year, 7, 0, 1), icon: '🤝' },
    { key: 'grandparents-day', name: 'Grandparents Day', date: addDays(laborDay, 6), icon: '👴' },
    { key: 'fall-equinox', name: 'First Day of Fall', date: new Date(year, 8, 22), icon: '🍂' },
    { key: 'halloween', name: 'Halloween', date: new Date(year, 9, 31), icon: '🎃' },
    { key: 'dst-end', name: 'Daylight Saving Time Ends', date: nthWeekdayOfMonth(year, 10, 0, 1), icon: '🕰️' },
    { key: 'winter-solstice', name: 'First Day of Winter', date: new Date(year, 11, 21), icon: '❄️' },
  ];

  return entries.map((entry) => ({
    id: `observance-${entry.key}-${year}`,
    name: entry.name,
    date: entry.date,
    icon: entry.icon,
    color: OBSERVANCE_HOLIDAY_COLOR,
    category: 'observance' as const,
  }));
};

// --- Christian holidays (Easter-derived, accurate for any year) ------

const getChristianHolidaysForYear = (year: number): HolidayEntry[] => {
  const easter = getEasterSunday(year);
  const entries: Array<{ key: string; name: string; date: Date }> = [
    { key: 'epiphany', name: 'Epiphany', date: new Date(year, 0, 6) },
    { key: 'ash-wednesday', name: 'Ash Wednesday', date: addDays(easter, -46) },
    { key: 'palm-sunday', name: 'Palm Sunday', date: addDays(easter, -7) },
    { key: 'good-friday', name: 'Good Friday', date: addDays(easter, -2) },
    { key: 'easter', name: 'Easter Sunday', date: easter },
    { key: 'christmas-eve', name: 'Christmas Eve', date: new Date(year, 11, 24) },
    { key: 'christmas', name: 'Christmas Day', date: new Date(year, 11, 25) },
  ];

  return entries.map((entry) => ({
    id: `christian-${entry.key}-${year}`,
    name: entry.name,
    date: entry.date,
    icon: RELIGION_ICONS.christian,
    color: RELIGION_COLORS.christian,
    category: 'christian' as const,
  }));
};

// --- Jewish, Muslim, and Hindu holidays -------------------------------
// The Hebrew, Islamic, and Hindu calendars are lunar/lunisolar and are not
// reducible to a simple date formula the way the Gregorian-based holidays
// above are. These dates are populated from general reference knowledge
// for 2026 only and have NOT been cross-checked against an authoritative
// calendrical source — please verify before relying on them, especially
// the Islamic dates, which are inherently approximate (moon-sighting can
// shift the observed date by a day in either direction depending on
// region/authority).

const RAW_JEWISH_HOLIDAYS: Record<number, Array<{ key: string; name: string; date: [number, number, number] }>> = {
  2026: [
    { key: 'purim', name: 'Purim', date: [2026, 3, 3] },
    { key: 'passover', name: 'Passover', date: [2026, 4, 2] },
    { key: 'shavuot', name: 'Shavuot', date: [2026, 5, 22] },
    { key: 'rosh-hashanah', name: 'Rosh Hashanah', date: [2026, 9, 12] },
    { key: 'yom-kippur', name: 'Yom Kippur', date: [2026, 9, 21] },
    { key: 'sukkot', name: 'Sukkot', date: [2026, 9, 26] },
    { key: 'hanukkah', name: 'Hanukkah', date: [2026, 12, 5] },
  ],
};

const RAW_MUSLIM_HOLIDAYS: Record<number, Array<{ key: string; name: string; date: [number, number, number] }>> = {
  2026: [
    { key: 'ramadan-start', name: 'Start of Ramadan', date: [2026, 2, 18] },
    { key: 'eid-al-fitr', name: 'Eid al-Fitr', date: [2026, 3, 20] },
    { key: 'eid-al-adha', name: 'Eid al-Adha', date: [2026, 5, 27] },
    { key: 'islamic-new-year', name: 'Islamic New Year', date: [2026, 6, 16] },
    { key: 'mawlid', name: 'Mawlid al-Nabi', date: [2026, 8, 25] },
  ],
};

const RAW_HINDU_HOLIDAYS: Record<number, Array<{ key: string; name: string; date: [number, number, number] }>> = {
  2026: [
    { key: 'holi', name: 'Holi', date: [2026, 3, 4] },
    { key: 'raksha-bandhan', name: 'Raksha Bandhan', date: [2026, 8, 28] },
    { key: 'janmashtami', name: 'Janmashtami', date: [2026, 9, 4] },
    { key: 'navratri', name: 'Navratri begins', date: [2026, 10, 11] },
    { key: 'dussehra', name: 'Dussehra', date: [2026, 10, 20] },
    { key: 'diwali', name: 'Diwali', date: [2026, 11, 8] },
  ],
};

const RAW_LUNAR_HOLIDAYS_BY_RELIGION: Record<'jewish' | 'muslim' | 'hindu', Record<number, Array<{ key: string; name: string; date: [number, number, number] }>>> = {
  jewish: RAW_JEWISH_HOLIDAYS,
  muslim: RAW_MUSLIM_HOLIDAYS,
  hindu: RAW_HINDU_HOLIDAYS,
};

const getLunarReligionHolidaysForYear = (religion: 'jewish' | 'muslim' | 'hindu', year: number): HolidayEntry[] => {
  const raw = RAW_LUNAR_HOLIDAYS_BY_RELIGION[religion][year];
  if (!raw) {
    return [];
  }

  return raw.map((entry) => ({
    id: `${religion}-${entry.key}-${year}`,
    name: entry.name,
    date: new Date(entry.date[0], entry.date[1] - 1, entry.date[2]),
    icon: RELIGION_ICONS[religion],
    color: RELIGION_COLORS[religion],
    category: religion,
  }));
};

export const getReligiousHolidaysForYear = (religion: HolidayReligion, year: number): HolidayEntry[] => {
  if (religion === 'christian') {
    return getChristianHolidaysForYear(year);
  }
  return getLunarReligionHolidaysForYear(religion, year);
};

// --- Combined, deduped, settings-aware holiday list -------------------

const dateKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export const getHolidayEntries = (settings: CalendarDefaultsSettings, years: number[]): HolidayEntry[] => {
  const publicHolidays = settings.usPublicEnabled
    ? years.flatMap((year) => getUsPublicHolidaysForYear(year))
    : [];

  const observanceHolidays = settings.observancesEnabled
    ? years.flatMap((year) => getObservanceHolidaysForYear(year))
    : [];

  const religiousHolidays = settings.religions.flatMap((religion) => years.flatMap((year) => getReligiousHolidaysForYear(religion, year)));

  const publicDateKeys = new Set(publicHolidays.map((entry) => dateKey(entry.date)));
  const dedupedObservanceHolidays = observanceHolidays.filter((entry) => !publicDateKeys.has(dateKey(entry.date)));
  const dedupedReligiousHolidays = religiousHolidays.filter((entry) => !publicDateKeys.has(dateKey(entry.date)));

  return [...publicHolidays, ...dedupedObservanceHolidays, ...dedupedReligiousHolidays].sort((a, b) => a.date.getTime() - b.date.getTime());
};
