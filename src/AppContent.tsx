import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
  Animated,
  Button,
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as Contacts from 'expo-contacts/legacy';
import * as SMS from 'expo-sms';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import {
  createShareInvite,
  findUserByEmail,
  findUserByPhone,
  findGoogleAddressPredictions,
  GoogleAddressPrediction,
  loadCalendarSyncSettings,
  loadUser,
  loadEvents,
  loadPendingShareInvites,
  PendingShareInvite,
  pushGoogleCalendarEvents,
  resolveGoogleAddressPrediction,
  respondToShareInvite,
  loadReminderDefaultTimeSettings,
  loadReminderDeliverySettings,
  type ReminderDefaultTimeSettings,
  loadReminderSoundSettings,
  saveEvents,
  sendShareEmailNotification,
  sendReminderEmailNotification,
  sendReminderSmsNotification,
  sendRsvpInvites,
  fetchRsvpInvites,
  fetchRsvpSummary,
  sendRsvpReminder,
  type RsvpSummaryResult,
  parseVoiceEventText,
  type VoiceParsedEventFields,
  loadUserContactsSnapshot,
  saveUserContactsSnapshot,
  subscribeApiStorageStatus,
  isApiStorageEnabled,
  validateEmail,
  validatePhoneNumber,
} from './storage';
import {
  clearScheduledReminders,
  getNotificationDiagnostics,
  playReminderPing,
  requestNotificationPermission,
  scheduleReminder,
} from './notifications';
import { getDeviceTimeZone } from './timeZones';
import TimePickerModal from './TimePickerModal';
import { EventLocationAddress, ReminderFrequency, SpecialDateEvent, VariableReminderEntry } from './types';
import { WIDGET_APP_GROUP_ID, WIDGET_DATA_KEY, WidgetSyncPayload } from './widgetSync';
import WidgetBridgeModule from '../modules/widget-bridge/src/WidgetBridgeModule';
import {
  CalendarDefaultsSettings,
  DEFAULT_CALENDAR_DEFAULTS_SETTINGS,
  getCalendarDefaultsStorageKey,
  getHolidayEntries,
  HolidayEntry,
  normalizeCalendarDefaultsSettings,
  OBSERVANCE_HOLIDAY_COLOR,
  OBSERVANCE_HOLIDAY_FILTER_ICON,
  RELIGIOUS_HOLIDAY_FILTER_COLOR,
  RELIGIOUS_HOLIDAY_FILTER_ICON,
  US_PUBLIC_HOLIDAY_COLOR,
  US_PUBLIC_HOLIDAY_ICON,
} from './holidays';
import { ThemeColors, useTheme } from './theme';
import TooltipButton from './TooltipButton';

type SavedEventsSummaryRow =
  | { kind: 'event'; id: string; date: Date; event: SpecialDateEvent }
  | { kind: 'holiday'; id: string; date: Date; holiday: HolidayEntry };

type EventTypeValue = 'birthday' | 'party' | 'wedding' | 'anniversary' | 'medical' | 'dental' | 'work' | 'school' | 'travel' | 'sports' | 'other';
type PartySubtypeValue = 'birthday' | 'anniversary' | 'retirement' | 'engagement' | 'holiday' | 'other';
type MedicalSubtypeValue = 'appointment' | 'surgery' | 'blood-work' | 'radiology' | 'rehab' | 'other';
type DentalSubtypeValue = 'cleaning' | 'extraction' | 'check-up' | 'root-canal' | 'bridge' | 'dentures' | 'cavities' | 'implants' | 'crown' | 'fitting' | 'other';
type WorkSubtypeValue = 'meeting' | 'review' | 'conference' | 'demo' | 'workshop' | 'presentation' | 'interview' | 'other';
type SchoolSubtypeValue = 'quiz' | 'test' | 'paper-due' | 'project-due' | 'class-presentation' | 'other';
type ReminderModeValue = 'none' | 'default' | 'static' | 'variable';
type TimePickerTarget = 'event-start' | 'event-end' | 'static-reminder' | 'pending-reminder';
type SavedEventsFilterType = EventTypeValue | 'holidays-public' | 'holidays-observances' | 'holidays-religious' | 'all';
type ReminderCandidate = {
  event: SpecialDateEvent;
  entry: VariableReminderEntry | null;
  reminderDateTime: string;
  entryId: string | null;
};

interface EventFormState {
  eventType: EventTypeValue;
  partySubtype: PartySubtypeValue;
  medicalSubtype: MedicalSubtypeValue;
  dentalSubtype: DentalSubtypeValue;
  workSubtype: WorkSubtypeValue;
  schoolSubtype: SchoolSubtypeValue;
  eventLocationEnabled: boolean;
  eventLocationName: string;
  eventLocationSaveEnabled: boolean;
  eventLocationPlaceId: string;
  eventLocationFormattedAddress: string;
  eventLocationLine1: string;
  eventLocationLine2: string;
  eventLocationCity: string;
  eventLocationState: string;
  eventLocationZip: string;
  eventLocationPhone: string;
  customType: string;
  ageAsOfToday: string;
  people: string;
  notes: string;
  frequency: ReminderFrequency;
  reminderMode: ReminderModeValue;
  eventDateTime: Date;
  eventEndDateTime: Date | null;
  eventAllDay: boolean;
  reminderDateTime: Date;
  reminderAllDay: boolean;
  reminderTimeZone: string;
  shareAfterSave: boolean;
  shareWithRsvp: boolean;
}

const DEVICE_TIME_ZONE = getDeviceTimeZone();
const IOS_SCHEDULE_LIMIT = 60;
const SHOW_NOTIFICATION_DIAGNOSTICS = __DEV__ || (
  typeof process !== 'undefined'
  && !!process.env
  && process.env.EXPO_PUBLIC_SHOW_NOTIFICATION_DIAGNOSTICS === 'true'
);
const SHARE_ACCEPT_BASE_URL = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_BASE_URL
  ? process.env.EXPO_PUBLIC_API_BASE_URL
  : 'http://localhost:4000').replace(/\/$/, '');

const normalizeClockIntervalMinutes = (value: number): 1 | 5 | 15 => {
  if (value === 1 || value === 5 || value === 15) {
    return value;
  }

  return 5;
};

const alignMinuteToClockInterval = (minute: number, interval: 1 | 5 | 15): number => {
  const normalizedMinute = Math.max(0, Math.min(59, Math.trunc(minute)));
  return normalizedMinute - (normalizedMinute % interval);
};

const getDateTimePartsForTimeZone = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => Number(parts.find((part) => part.type === type)?.value || '0');

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second'),
  };
};

const getTimeZoneOffsetMilliseconds = (date: Date, timeZone: string) => {
  const parts = getDateTimePartsForTimeZone(date, timeZone);
  const utcFromZoneParts = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return utcFromZoneParts - date.getTime();
};

const convertWallDateInTimeZoneToUtcIso = (date: Date, timeZone: string) => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  const millisecond = date.getMilliseconds();

  let utcTimestamp = Date.UTC(year, month, day, hour, minute, second, millisecond);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const offset = getTimeZoneOffsetMilliseconds(new Date(utcTimestamp), timeZone);
    const adjusted = Date.UTC(year, month, day, hour, minute, second, millisecond) - offset;
    if (adjusted === utcTimestamp) {
      break;
    }
    utcTimestamp = adjusted;
  }

  return new Date(utcTimestamp).toISOString();
};

const toNaiveTimestamp = (parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number; millisecond?: number }) => (
  Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0,
    parts.millisecond || 0,
  )
);

const eventTypeLabels: Record<EventTypeValue, string> = {
  birthday: 'Birthday',
  party: 'Party',
  wedding: 'Wedding',
  anniversary: 'Anniversary',
  medical: 'Medical',
  dental: 'Dental',
  work: 'Work',
  school: 'School',
  travel: 'Travel',
  sports: 'Sports',
  other: 'Other',
};

const partySubtypeLabels: Record<PartySubtypeValue, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  retirement: 'Retirement',
  engagement: 'Engagement',
  holiday: 'Holiday',
  other: 'Other',
};

const schoolSubtypeLabels: Record<SchoolSubtypeValue, string> = {
  quiz: 'Quiz',
  test: 'Test',
  'paper-due': 'Paper due',
  'project-due': 'Project due',
  'class-presentation': 'Class presentation',
  other: 'Other',
};

const medicalSubtypeLabels: Record<MedicalSubtypeValue, string> = {
  appointment: 'Appointment',
  surgery: 'Surgery',
  'blood-work': 'Blood Work',
  radiology: 'Radiology',
  rehab: 'Rehab',
  other: 'Other',
};

const dentalSubtypeLabels: Record<DentalSubtypeValue, string> = {
  cleaning: 'Cleaning',
  extraction: 'Extraction',
  'check-up': 'Check Up',
  'root-canal': 'Root Canal',
  bridge: 'Bridge',
  dentures: 'Dentures',
  cavities: 'Cavities',
  implants: 'Implants',
  crown: 'Crown',
  fitting: 'Fitting',
  other: 'Other',
};

const workSubtypeLabels: Record<WorkSubtypeValue, string> = {
  meeting: 'Meeting',
  review: 'Review',
  conference: 'Conference',
  demo: 'Demo',
  workshop: 'Workshop',
  presentation: 'Presentation',
  interview: 'Interview',
  other: 'Other',
};

const usStateOptions = [
  { code: 'AL', label: 'Alabama' },
  { code: 'AK', label: 'Alaska' },
  { code: 'AZ', label: 'Arizona' },
  { code: 'AR', label: 'Arkansas' },
  { code: 'CA', label: 'California' },
  { code: 'CO', label: 'Colorado' },
  { code: 'CT', label: 'Connecticut' },
  { code: 'DE', label: 'Delaware' },
  { code: 'DC', label: 'District of Columbia' },
  { code: 'FL', label: 'Florida' },
  { code: 'GA', label: 'Georgia' },
  { code: 'HI', label: 'Hawaii' },
  { code: 'ID', label: 'Idaho' },
  { code: 'IL', label: 'Illinois' },
  { code: 'IN', label: 'Indiana' },
  { code: 'IA', label: 'Iowa' },
  { code: 'KS', label: 'Kansas' },
  { code: 'KY', label: 'Kentucky' },
  { code: 'LA', label: 'Louisiana' },
  { code: 'ME', label: 'Maine' },
  { code: 'MD', label: 'Maryland' },
  { code: 'MA', label: 'Massachusetts' },
  { code: 'MI', label: 'Michigan' },
  { code: 'MN', label: 'Minnesota' },
  { code: 'MS', label: 'Mississippi' },
  { code: 'MO', label: 'Missouri' },
  { code: 'MT', label: 'Montana' },
  { code: 'NE', label: 'Nebraska' },
  { code: 'NV', label: 'Nevada' },
  { code: 'NH', label: 'New Hampshire' },
  { code: 'NJ', label: 'New Jersey' },
  { code: 'NM', label: 'New Mexico' },
  { code: 'NY', label: 'New York' },
  { code: 'NC', label: 'North Carolina' },
  { code: 'ND', label: 'North Dakota' },
  { code: 'OH', label: 'Ohio' },
  { code: 'OK', label: 'Oklahoma' },
  { code: 'OR', label: 'Oregon' },
  { code: 'PA', label: 'Pennsylvania' },
  { code: 'RI', label: 'Rhode Island' },
  { code: 'SC', label: 'South Carolina' },
  { code: 'SD', label: 'South Dakota' },
  { code: 'TN', label: 'Tennessee' },
  { code: 'TX', label: 'Texas' },
  { code: 'UT', label: 'Utah' },
  { code: 'VT', label: 'Vermont' },
  { code: 'VA', label: 'Virginia' },
  { code: 'WA', label: 'Washington' },
  { code: 'WV', label: 'West Virginia' },
  { code: 'WI', label: 'Wisconsin' },
  { code: 'WY', label: 'Wyoming' },
];

const usStateNameToCode = usStateOptions.reduce<Record<string, string>>((accumulator, option) => {
  accumulator[option.label.toLowerCase()] = option.code;
  return accumulator;
}, {});

const eventTypeOptions: Array<{ label: string; value: EventTypeValue }> = Object.entries(eventTypeLabels).map(
  ([value, label]) => ({ label, value: value as EventTypeValue }),
);

const eventTypeHasSubtype = (eventType: EventTypeValue) => (
  eventType === 'party'
  || eventType === 'school'
  || eventType === 'medical'
  || eventType === 'dental'
  || eventType === 'work'
);

const getSubtypeFieldLabel = (eventType: EventTypeValue) => {
  switch (eventType) {
    case 'party':
      return 'Party subtype';
    case 'school':
      return 'School subtype';
    case 'medical':
      return 'Medical subtype';
    case 'dental':
      return 'Dental subtype';
    case 'work':
      return 'Work subtype';
    default:
      return null;
  }
};

const getSubtypeDisplayLabel = (form: EventFormState) => {
  switch (form.eventType) {
    case 'party':
      return partySubtypeLabels[form.partySubtype];
    case 'school':
      return schoolSubtypeLabels[form.schoolSubtype];
    case 'medical':
      return medicalSubtypeLabels[form.medicalSubtype];
    case 'dental':
      return dentalSubtypeLabels[form.dentalSubtype];
    case 'work':
      return workSubtypeLabels[form.workSubtype];
    default:
      return '';
  }
};

const getSubtypeValueForEventType = (
  form: EventFormState,
  eventType: EventTypeValue,
) => {
  switch (eventType) {
    case 'party':
      return form.partySubtype;
    case 'school':
      return form.schoolSubtype;
    case 'medical':
      return form.medicalSubtype;
    case 'dental':
      return form.dentalSubtype;
    case 'work':
      return form.workSubtype;
    default:
      return '';
  }
};

const getDefaultDate = () => {
  const nextDate = new Date();
  nextDate.setMinutes(0, 0, 0);
  nextDate.setHours(nextDate.getHours() + 1);
  return nextDate;
};

const getDefaultEndDate = (startDate: Date) => {
  const nextEndDate = new Date(startDate);
  nextEndDate.setHours(nextEndDate.getHours() + 1);
  return nextEndDate;
};

const createEventId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createDefaultForm = (reminderTimeZone: string): EventFormState => {
  const defaultEventDateTime = getDefaultDate();
  return {
    eventType: 'birthday' as EventTypeValue,
    partySubtype: 'birthday' as PartySubtypeValue,
    medicalSubtype: 'appointment' as MedicalSubtypeValue,
    dentalSubtype: 'cleaning' as DentalSubtypeValue,
    workSubtype: 'meeting' as WorkSubtypeValue,
    schoolSubtype: 'quiz' as SchoolSubtypeValue,
    eventLocationEnabled: false,
    eventLocationName: '',
    eventLocationSaveEnabled: false,
    eventLocationPlaceId: '',
    eventLocationFormattedAddress: '',
    eventLocationLine1: '',
    eventLocationLine2: '',
    eventLocationCity: '',
    eventLocationState: '',
    eventLocationZip: '',
    eventLocationPhone: '',
    customType: '',
    ageAsOfToday: '',
    people: '',
    notes: '',
    frequency: 'monthly' as ReminderFrequency,
    reminderMode: 'none' as ReminderModeValue,
    eventDateTime: defaultEventDateTime,
    eventEndDateTime: getDefaultEndDate(defaultEventDateTime),
    eventAllDay: false,
    reminderDateTime: new Date(0),
    reminderAllDay: false,
    reminderTimeZone,
    shareAfterSave: false,
    shareWithRsvp: false,
  };
};

const getResetFormState = (reminderTimeZone: string): EventFormState => {
  const now = new Date();
  now.setSeconds(0);
  return {
    ...createDefaultForm(reminderTimeZone),
    eventDateTime: new Date(now),
    eventEndDateTime: getDefaultEndDate(new Date(now)),
    reminderDateTime: new Date(0),
  };
};

const isNoReminderMode = (mode: ReminderModeValue) => mode === 'none';

const isDefaultReminderMode = (mode: ReminderModeValue) => mode === 'default';

const isScheduledReminderMode = (mode: ReminderModeValue) => mode === 'default' || mode === 'static' || mode === 'variable';

const isReminderTimeZoneMode = (mode: ReminderModeValue) => mode === 'static' || mode === 'variable';

const getReminderModeHoverMessage = (mode: ReminderModeValue) => {
  switch (mode) {
    case 'none':
      return 'No Reminders will be written to the queue';
    case 'default':
      return 'Up to four Reminders will be written to the queue';
    case 'static':
      return 'Choose the Frequency of your Reminders';
    case 'variable':
      return 'Create Custom Reminders';
    default:
      return '';
  }
};

const getEventTitle = (
  eventType: EventTypeValue,
  partySubtype: PartySubtypeValue,
  customType: string,
  schoolSubtype?: SchoolSubtypeValue,
  medicalSubtype?: MedicalSubtypeValue,
  dentalSubtype?: DentalSubtypeValue,
  workSubtype?: WorkSubtypeValue,
) => {
  if (eventType === 'party') {
    if (partySubtype === 'other') {
      return 'Party';
    }
    return `${partySubtypeLabels[partySubtype]} Party`;
  }

  if (eventType === 'medical') {
    if (!medicalSubtype || medicalSubtype === 'other') {
      return 'Medical';
    }
    return `Medical ${medicalSubtypeLabels[medicalSubtype]}`;
  }

  if (eventType === 'dental') {
    if (!dentalSubtype || dentalSubtype === 'other') {
      return 'Dental';
    }
    return `Dental ${dentalSubtypeLabels[dentalSubtype]}`;
  }

  if (eventType === 'work') {
    if (!workSubtype || workSubtype === 'other') {
      return 'Work';
    }
    return `Work ${workSubtypeLabels[workSubtype]}`;
  }

  if (eventType === 'school') {
    if (!schoolSubtype || schoolSubtype === 'other') {
      return 'School';
    }
    return schoolSubtypeLabels[schoolSubtype];
  }

  if (eventType === 'other') {
    return customType.trim();
  }

  return eventTypeLabels[eventType];
};

type EventSummaryCategory =
  | 'birthday'
  | 'anniversary'
  | 'wedding'
  | 'medical'
  | 'dental'
  | 'work'
  | 'school'
  | 'travel'
  | 'sports'
  | 'retirement'
  | 'engagement'
  | 'holiday'
  | 'party'
  | 'other';

const EVENT_SUMMARY_COLORS: Record<EventSummaryCategory, string> = {
  birthday: '#4169E1',
  anniversary: '#5B2C87',
  medical: '#DC2626',
  school: '#16A34A',
  work: '#EA580C',
  dental: '#8B4513',
  wedding: '#B8860B',
  party: '#5DADE2',
  engagement: '#EC4899',
  retirement: '#8E8E93',
  holiday: '#A68A64',
  travel: '#0D9488',
  sports: '#9F1239',
  other: '#C2410C',
};

const EVENT_SUMMARY_ICONS: Record<EventSummaryCategory, string> = {
  birthday: '🎂',
  anniversary: '💑',
  wedding: '💒',
  medical: '🩺',
  dental: '🦷',
  work: '💼',
  school: '🎓',
  retirement: '🏖️',
  engagement: '💍',
  holiday: '🎊',
  party: '🎉',
  travel: '✈️',
  sports: '⚽',
  other: '📌',
};

const schoolSubtypeTitleSet = new Set(
  Object.entries(schoolSubtypeLabels).filter(([key]) => key !== 'other').map(([, label]) => label),
);

const getEventSummaryCategory = (event: SpecialDateEvent): EventSummaryCategory => {
  const normalizedTitle = event.title.toLowerCase().trim();

  // A plain "Birthday"/"Anniversary" event and a "Birthday Party"/"Anniversary Party" event
  // are distinct occasions, so only the bare (non-party) title keeps this category — the
  // party-titled version falls through to the generic party category below, same as any
  // other party subtype without its own dedicated color/icon (e.g. a plain "Party").
  if (normalizedTitle === 'birthday') {
    return 'birthday';
  }

  if (normalizedTitle === 'anniversary') {
    return 'anniversary';
  }

  if (normalizedTitle === 'wedding') {
    return 'wedding';
  }

  if (normalizedTitle === 'medical' || normalizedTitle.startsWith('medical ')) {
    return 'medical';
  }

  if (normalizedTitle === 'dental' || normalizedTitle.startsWith('dental ')) {
    return 'dental';
  }

  if (normalizedTitle === 'work' || normalizedTitle.startsWith('work ')) {
    return 'work';
  }

  if (normalizedTitle === 'school' || schoolSubtypeTitleSet.has(event.title.trim())) {
    return 'school';
  }

  if (normalizedTitle === 'travel' || normalizedTitle.startsWith('travel ')) {
    return 'travel';
  }

  if (normalizedTitle === 'sports' || normalizedTitle.startsWith('sports ')) {
    return 'sports';
  }

  if (normalizedTitle === 'retirement party') {
    return 'retirement';
  }

  if (normalizedTitle === 'engagement party') {
    return 'engagement';
  }

  if (normalizedTitle === 'holiday party') {
    return 'holiday';
  }

  if (normalizedTitle === 'party' || normalizedTitle.endsWith(' party')) {
    return 'party';
  }

  return 'other';
};

const getEventSummaryColor = (event: SpecialDateEvent): string => EVENT_SUMMARY_COLORS[getEventSummaryCategory(event)];

const getEventSummaryIcon = (event: SpecialDateEvent): string => EVENT_SUMMARY_ICONS[getEventSummaryCategory(event)];

const isPartyOrWeddingEvent = (event: SpecialDateEvent): boolean => {
  const normalizedTitle = event.title.toLowerCase().trim();
  return normalizedTitle === 'wedding' || normalizedTitle.endsWith(' party') || normalizedTitle === 'party';
};

const getSavedEventsFilterOptionStyle = (value: SavedEventsFilterType): { color: string | null; icon: string | null } => {
  if (value === 'all') {
    return { color: null, icon: null };
  }
  if (value === 'holidays-public') {
    return { color: US_PUBLIC_HOLIDAY_COLOR, icon: US_PUBLIC_HOLIDAY_ICON };
  }
  if (value === 'holidays-observances') {
    return { color: OBSERVANCE_HOLIDAY_COLOR, icon: OBSERVANCE_HOLIDAY_FILTER_ICON };
  }
  if (value === 'holidays-religious') {
    return { color: RELIGIOUS_HOLIDAY_FILTER_COLOR, icon: RELIGIOUS_HOLIDAY_FILTER_ICON };
  }
  return { color: EVENT_SUMMARY_COLORS[value], icon: EVENT_SUMMARY_ICONS[value] };
};

const normalizeDuplicateText = (value: string) => String(value || '').trim().toLowerCase();

const getUtcDateKey = (value: Date) => (
  `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
);

const getLocalDateFromUtcDay = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date(value);
  }

  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
};

const getMinuteTimestamp = (value: Date) => Math.floor(value.getTime() / (60 * 1000));

const isTrueDuplicateEvent = (
  existingEvent: SpecialDateEvent,
  candidate: {
    title: string;
    people: string;
    eventDateTime: Date;
    eventAllDay: boolean;
  },
) => {
  if (normalizeDuplicateText(existingEvent.title) !== normalizeDuplicateText(candidate.title)) {
    return false;
  }

  if (normalizeDuplicateText(existingEvent.people) !== normalizeDuplicateText(candidate.people)) {
    return false;
  }

  if (Boolean(existingEvent.eventAllDay) !== candidate.eventAllDay) {
    return false;
  }

  const existingDate = new Date(existingEvent.eventDateTime);
  const candidateDate = new Date(candidate.eventDateTime);
  const existingTime = existingDate.getTime();
  const candidateTime = candidateDate.getTime();
  if (!Number.isFinite(existingTime) || !Number.isFinite(candidateTime)) {
    return false;
  }

  if (candidate.eventAllDay) {
    return getUtcDateKey(existingDate) === getUtcDateKey(candidateDate);
  }

  return getMinuteTimestamp(existingDate) === getMinuteTimestamp(candidateDate);
};

const getDuplicateEventValidationMessage = () => (
  'A matching event already exists for that Person/People/Group/Place/Description and date.'
);

const buildEventLocationFromForm = (form: {
  eventLocationEnabled: boolean;
  eventLocationName: string;
  eventLocationPlaceId: string;
  eventLocationFormattedAddress: string;
  eventLocationLine1: string;
  eventLocationLine2: string;
  eventLocationCity: string;
  eventLocationState: string;
  eventLocationZip: string;
  eventLocationPhone: string;
}): EventLocationAddress | undefined => {
  if (!form.eventLocationEnabled) {
    return undefined;
  }

  const name = form.eventLocationName.trim();
  const line1 = form.eventLocationLine1.trim();
  const line2 = form.eventLocationLine2.trim();
  const city = form.eventLocationCity.trim();
  const state = normalizeStateCode(form.eventLocationState);
  const zip = normalizeZipCode(form.eventLocationZip);
  const phone = formatPhoneNumberInput(form.eventLocationPhone.trim());
  const placeId = form.eventLocationPlaceId.trim();
  const formattedAddress = form.eventLocationFormattedAddress.trim();

  if (!name && !line1 && !line2 && !city && !state && !zip && !formattedAddress && !phone) {
    return undefined;
  }

  return {
    ...(name ? { name } : {}),
    ...(placeId ? { placeId } : {}),
    ...(formattedAddress ? { formattedAddress } : {}),
    ...(phone ? { phone } : {}),
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    state,
    zip,
  };
};

const formatReminderTimeLabel = (hour: number, minute: number) => {
  const normalizedHour = Math.max(0, Math.min(23, Math.trunc(hour)));
  const normalizedMinute = Math.max(0, Math.min(59, Math.trunc(minute)));
  const period = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 || 12;
  return `${String(displayHour).padStart(2, '0')}:${String(normalizedMinute).padStart(2, '0')} ${period}`;
};

const formatPhoneNumberInput = (value: string) => {
  const rawDigits = String(value || '').replace(/\D/g, '');
  const digits = rawDigits.length === 11 && rawDigits.startsWith('1')
    ? rawDigits.slice(1)
    : rawDigits.slice(0, 10);

  if (!digits) {
    return '';
  }

  if (digits.length <= 3) {
    return `(${digits}`;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

const getAgeAsOfToday = (birthDate: Date) => {
  const timestamp = birthDate.getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear = (
    today.getMonth() > birthDate.getMonth()
    || (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate())
  );

  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }

  return age >= 0 ? age : null;
};

const getDefaultBirthdayAgeString = (birthDate: Date) => {
  const age = getAgeAsOfToday(birthDate);
  return age === null ? '' : String(age);
};

const normalizeZipCode = (value: string) => value.replace(/\D/g, '').slice(0, 5);

const normalizeStateCode = (value: string) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const upper = normalized.toUpperCase();
  const byCode = usStateOptions.find((option) => option.code === upper);
  if (byCode) {
    return byCode.code;
  }

  const byName = usStateNameToCode[normalized.toLowerCase()];
  return byName || '';
};

const getStateLabelFromCode = (code: string) => {
  const option = usStateOptions.find((entry) => entry.code === code);
  return option ? option.label : code;
};

const getAcceptLinkForCurrentPlatform = (recipientUserId: string, eventId: string) => {
  const query = `recipient=${encodeURIComponent(recipientUserId)}&event=${encodeURIComponent(eventId)}`;
  return `${SHARE_ACCEPT_BASE_URL}/shares/accept?${query}`;
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const copyTextToClipboard = async (value: string) => {
  if (!value.trim()) {
    return false;
  }

  try {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard;
    if (!clipboard?.writeText) {
      return false;
    }

    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

const buildDefaultReminderDrafts = (
  eventDateTime: Date,
  notes: string,
  people: string,
  title: string,
  reminderTime: { hour: number; minute: number },
): SpecialDateEvent[] => {
  const now = Date.now();
  const sourceDate = new Date(eventDateTime);
  const reminderSpecs = [
    { idPrefix: 'month', kind: 'month' as const },
    { idPrefix: 'week', kind: 'week' as const },
    { idPrefix: 'day', kind: 'day' as const },
    { idPrefix: 'event', kind: 'event' as const },
  ];

  const createReminderDate = (kind: 'month' | 'week' | 'day' | 'event') => {
    const reminderDate = new Date(sourceDate);
    reminderDate.setSeconds(0, 0);
    reminderDate.setHours(reminderTime.hour, reminderTime.minute, 0, 0);

    if (kind === 'month') {
      const targetYear = reminderDate.getFullYear();
      const targetMonth = reminderDate.getMonth() - 1;
      const dayOfMonth = reminderDate.getDate();
      const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
      reminderDate.setFullYear(targetYear, targetMonth, Math.min(dayOfMonth, daysInTargetMonth));
    }

    if (kind === 'week') {
      reminderDate.setDate(reminderDate.getDate() - 7);
    }

    if (kind === 'day') {
      reminderDate.setDate(reminderDate.getDate() - 1);
    }

    return reminderDate;
  };

  const reminders: Array<SpecialDateEvent | null> = reminderSpecs
    .map((spec) => {
      const reminderDateTime = createReminderDate(spec.kind);
      if (reminderDateTime.getTime() < now) {
        return null;
      }

      return {
        id: `default-${spec.idPrefix}-${reminderDateTime.getTime()}`,
        title: title || 'Reminder',
        people: people || 'You',
        eventDateTime: sourceDate.toISOString(),
        reminderDateTime: reminderDateTime.toISOString(),
        eventAllDay: false,
        reminderAllDay: false,
        frequency: 'once' as ReminderFrequency,
        notes: notes || '',
        notified: false,
      } satisfies SpecialDateEvent;
    });

  return reminders
    .filter((item): item is SpecialDateEvent => item !== null)
    .sort((left, right) => new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime());
};

const getEventFormState = (event: SpecialDateEvent): EventFormState => {
  const normalizedTitle = event.title.toLowerCase().trim();
  const eventLocation = event.eventLocation;
  const hasEventLocation = Boolean(
    eventLocation
    && (
      eventLocation.name
      || eventLocation.line1
      || eventLocation.line2
      || eventLocation.city
      || eventLocation.state
      || eventLocation.zip
      || eventLocation.formattedAddress
      || eventLocation.phone
    ),
  );

  const baseState: EventFormState = {
    eventType: 'birthday',
    partySubtype: 'birthday',
    schoolSubtype: 'quiz',
    medicalSubtype: 'appointment',
    dentalSubtype: 'cleaning',
    workSubtype: 'meeting',
    eventLocationEnabled: hasEventLocation,
    eventLocationName: eventLocation?.name || '',
    eventLocationSaveEnabled: false,
    eventLocationPlaceId: eventLocation?.placeId || '',
    eventLocationFormattedAddress: eventLocation?.formattedAddress || '',
    eventLocationLine1: eventLocation?.line1 || '',
    eventLocationLine2: eventLocation?.line2 || '',
    eventLocationCity: eventLocation?.city || '',
    eventLocationState: normalizeStateCode(eventLocation?.state || ''),
    eventLocationZip: eventLocation?.zip || '',
    eventLocationPhone: formatPhoneNumberInput(eventLocation?.phone || ''),
    customType: '',
    ageAsOfToday: '',
    people: '',
    notes: '',
    frequency: 'monthly',
    reminderMode: 'none',
    eventDateTime: new Date(),
    eventEndDateTime: new Date(),
    eventAllDay: false,
    reminderDateTime: new Date(),
    reminderAllDay: false,
    reminderTimeZone: event.reminderTimeZone || getDeviceTimeZone(),
    shareAfterSave: false,
    shareWithRsvp: false,
  };

  if (normalizedTitle === 'birthday') {
    return { ...baseState, eventType: 'birthday' };
  }

  if (normalizedTitle.endsWith(' party')) {
    const baseLabel = normalizedTitle.slice(0, -' party'.length);
    if (baseLabel === 'birthday') {
      return { ...baseState, eventType: 'party' as EventTypeValue, partySubtype: 'birthday' as PartySubtypeValue };
    }

    if (baseLabel === 'anniversary') {
      return { ...baseState, eventType: 'party' as EventTypeValue, partySubtype: 'anniversary' as PartySubtypeValue };
    }

    if (baseLabel === 'retirement') {
      return { ...baseState, eventType: 'party' as EventTypeValue, partySubtype: 'retirement' as PartySubtypeValue };
    }

    if (baseLabel === 'engagement') {
      return { ...baseState, eventType: 'party' as EventTypeValue, partySubtype: 'engagement' as PartySubtypeValue };
    }

    if (baseLabel === 'holiday') {
      return { ...baseState, eventType: 'party' as EventTypeValue, partySubtype: 'holiday' as PartySubtypeValue };
    }
  }

  if (normalizedTitle === 'doctors appointment' || normalizedTitle === 'medical appointment') {
    return { ...baseState, eventType: 'medical' as EventTypeValue, medicalSubtype: 'appointment' as MedicalSubtypeValue };
  }

  if (normalizedTitle.startsWith('medical ')) {
    const medicalLabel = normalizedTitle.slice('medical '.length).trim();
    const medicalSubtypeMap: Record<string, MedicalSubtypeValue> = {
      appointment: 'appointment',
      surgery: 'surgery',
      'blood work': 'blood-work',
      radiology: 'radiology',
      rehab: 'rehab',
    };

    if (medicalSubtypeMap[medicalLabel]) {
      return {
        ...baseState,
        eventType: 'medical' as EventTypeValue,
        medicalSubtype: medicalSubtypeMap[medicalLabel],
      };
    }
  }

  const standaloneMedicalSubtypeMap: Record<string, MedicalSubtypeValue> = {
    appointment: 'appointment',
    surgery: 'surgery',
    'blood work': 'blood-work',
    radiology: 'radiology',
    rehab: 'rehab',
  };

  if (standaloneMedicalSubtypeMap[normalizedTitle]) {
    return {
      ...baseState,
      eventType: 'medical' as EventTypeValue,
      medicalSubtype: standaloneMedicalSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'dental') {
    return { ...baseState, eventType: 'dental' as EventTypeValue, dentalSubtype: 'other' as DentalSubtypeValue };
  }

  if (normalizedTitle.startsWith('dental ')) {
    const dentalLabel = normalizedTitle.slice('dental '.length).trim();
    const dentalSubtypeMap: Record<string, DentalSubtypeValue> = {
      cleaning: 'cleaning',
      extraction: 'extraction',
      'check up': 'check-up',
      'root canal': 'root-canal',
      bridge: 'bridge',
      dentures: 'dentures',
      cavities: 'cavities',
      implants: 'implants',
      crown: 'crown',
      fitting: 'fitting',
    };

    if (dentalSubtypeMap[dentalLabel]) {
      return {
        ...baseState,
        eventType: 'dental' as EventTypeValue,
        dentalSubtype: dentalSubtypeMap[dentalLabel],
      };
    }
  }

  const standaloneDentalSubtypeMap: Record<string, DentalSubtypeValue> = {
    cleaning: 'cleaning',
    extraction: 'extraction',
    'check up': 'check-up',
    'root canal': 'root-canal',
    bridge: 'bridge',
    dentures: 'dentures',
    cavities: 'cavities',
    implants: 'implants',
    crown: 'crown',
    fitting: 'fitting',
  };

  if (standaloneDentalSubtypeMap[normalizedTitle]) {
    return {
      ...baseState,
      eventType: 'dental' as EventTypeValue,
      dentalSubtype: standaloneDentalSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'work') {
    return { ...baseState, eventType: 'work' as EventTypeValue, workSubtype: 'other' as WorkSubtypeValue };
  }

  if (normalizedTitle.startsWith('work ')) {
    const workLabel = normalizedTitle.slice('work '.length).trim();
    const workSubtypeMap: Record<string, WorkSubtypeValue> = {
      meeting: 'meeting',
      review: 'review',
      conference: 'conference',
      demo: 'demo',
      workshop: 'workshop',
      presentation: 'presentation',
      interview: 'interview',
    };

    if (workSubtypeMap[workLabel]) {
      return {
        ...baseState,
        eventType: 'work' as EventTypeValue,
        workSubtype: workSubtypeMap[workLabel],
      };
    }
  }

  const standaloneWorkSubtypeMap: Record<string, WorkSubtypeValue> = {
    meeting: 'meeting',
    review: 'review',
    conference: 'conference',
    demo: 'demo',
    workshop: 'workshop',
    presentation: 'presentation',
    interview: 'interview',
  };

  if (standaloneWorkSubtypeMap[normalizedTitle]) {
    return {
      ...baseState,
      eventType: 'work' as EventTypeValue,
      workSubtype: standaloneWorkSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'school') {
    return { ...baseState, eventType: 'school' as EventTypeValue, schoolSubtype: 'other' as SchoolSubtypeValue };
  }

  if (normalizedTitle.startsWith('school ')) {
    const schoolLabel = normalizedTitle.slice('school '.length).trim();
    const schoolSubtypeMap: Record<string, SchoolSubtypeValue> = {
      quiz: 'quiz',
      test: 'test',
      'paper due': 'paper-due',
      'project due': 'project-due',
      'class presentation': 'class-presentation',
    };

    if (schoolSubtypeMap[schoolLabel]) {
      return {
        ...baseState,
        eventType: 'school' as EventTypeValue,
        schoolSubtype: schoolSubtypeMap[schoolLabel],
      };
    }
  }

  const standaloneSchoolSubtypeMap: Record<string, SchoolSubtypeValue> = {
    quiz: 'quiz',
    test: 'test',
    'paper due': 'paper-due',
    'project due': 'project-due',
    'class presentation': 'class-presentation',
  };

  if (standaloneSchoolSubtypeMap[normalizedTitle]) {
    return {
      ...baseState,
      eventType: 'school' as EventTypeValue,
      schoolSubtype: standaloneSchoolSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'wedding' || normalizedTitle === 'anniversary') {
    const eventTypeMap: Record<string, EventTypeValue> = {
      wedding: 'wedding',
      anniversary: 'anniversary',
    };

    return {
      ...baseState,
      eventType: eventTypeMap[normalizedTitle],
    };
  }

  return {
    ...baseState,
    eventType: 'other' as EventTypeValue,
    customType: event.title,
  };
};

const formatDisplayDate = (value: string | Date | null | undefined, allDay = false) => {
  if (!value) {
    return 'Not available';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Not available';
  }

  const normalizedDate = allDay ? getLocalDateFromUtcDay(date) : date;

  return allDay
    ? normalizedDate.toLocaleDateString()
    : `${normalizedDate.toLocaleDateString()} ${normalizedDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

const formatDetailDateLabel = (value: string | Date | null | undefined, allDay = false) => {
  const base = formatDisplayDate(value, allDay);
  return allDay ? `${base} • All day` : base;
};

const formatEventDateAndTimeLabel = (event: SpecialDateEvent) => {
  const isAllDay = isAllDaySpecialDateEvent(event);
  const startDate = isAllDay
    ? getLocalDateFromUtcDay(event.eventDateTime)
    : new Date(event.eventDateTime);

  const dateLabel = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (isAllDay) {
    return `Event Date: ${dateLabel} • All day`;
  }

  const startTimeLabel = startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endDateTime = event.eventEndDateTime ? new Date(event.eventEndDateTime) : null;
  if (endDateTime && Number.isFinite(endDateTime.getTime())) {
    const endTimeLabel = endDateTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Event Date: ${dateLabel} • ${startTimeLabel} - ${endTimeLabel}`;
  }

  return `Event Date: ${dateLabel} • ${startTimeLabel}`;
};

const getEventLocationDisplayLines = (eventLocation?: EventLocationAddress) => {
  if (!eventLocation) {
    return [] as string[];
  }

  const name = eventLocation.name ? eventLocation.name.trim() : '';
  const line1 = eventLocation.line1.trim();
  const line2 = eventLocation.line2 ? eventLocation.line2.trim() : '';
  const city = eventLocation.city.trim();
  const state = getStateLabelFromCode(normalizeStateCode(eventLocation.state.trim()));
  const zip = eventLocation.zip.trim();
  const phone = eventLocation.phone ? formatPhoneNumberInput(eventLocation.phone.trim()) : '';
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').trim();
  const fallback = eventLocation.formattedAddress ? eventLocation.formattedAddress.trim() : '';
  const lines = [name, line1, line2, cityStateZip, phone ? `Phone: ${phone}` : ''].filter(Boolean);

  if (lines.length) {
    return lines;
  }

  if (fallback) {
    return fallback.split(',').map((part) => part.trim()).filter(Boolean);
  }

  return [] as string[];
};

const isBirthdayEvent = (event: SpecialDateEvent) => {
  const normalizedTitle = event.title.toLowerCase().trim();
  return normalizedTitle === 'birthday' || normalizedTitle === 'birthday party' || normalizedTitle.endsWith('birthday party');
};

const isBirthdayOrAnniversaryEvent = (event: SpecialDateEvent) => {
  const normalizedTitle = event.title.toLowerCase().trim();
  return normalizedTitle === 'birthday' || normalizedTitle === 'anniversary';
};

const isSameCalendarDay = (left: Date, right: Date) => (
  left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth()
  && left.getDate() === right.getDate()
);

// Timed events can only be reminded up to and including their start instant.
// All-day events have no meaningful "start instant", so any time on the
// event's own calendar day is a valid reminder time (but not a later day).
const isReminderTimeWithinEventWindow = (reminderDate: Date, eventDate: Date, eventAllDay: boolean) => {
  if (eventAllDay) {
    return reminderDate.getTime() <= eventDate.getTime() || isSameCalendarDay(reminderDate, eventDate);
  }
  return reminderDate.getTime() <= eventDate.getTime();
};

const isAllDaySpecialDateEvent = (event: SpecialDateEvent) => {
  const normalizedTitle = event.title.toLowerCase().trim();
  if (normalizedTitle.endsWith(' party')) {
    return false;
  }

  if (event.eventAllDay) {
    return true;
  }

  return normalizedTitle === 'birthday' || normalizedTitle === 'anniversary';
};

const shouldKeepAfterEventTimePasses = (event: SpecialDateEvent) => {
  const normalizedTitle = event.title.toLowerCase().trim();
  if (normalizedTitle.includes('birthday') || normalizedTitle.includes('anniversary')) {
    return true;
  }

  return event.frequency === 'yearly';
};

const shouldRemovePastEvent = (event: SpecialDateEvent, now: Date) => {
  if (shouldKeepAfterEventTimePasses(event)) {
    return false;
  }

  const eventTime = new Date(event.eventDateTime).getTime();
  if (!Number.isFinite(eventTime)) {
    return false;
  }

  return eventTime < now.getTime();
};

const isAllDayEvent = (eventType: EventTypeValue, partySubtype: PartySubtypeValue, eventAllDay: boolean) => {
  if (eventType === 'birthday' || eventType === 'anniversary') {
    return true;
  }

  if (eventType === 'party') {
    return false;
  }

  return eventAllDay;
};

const supportsEventEndTime = (eventType: EventTypeValue, partySubtype: PartySubtypeValue, eventAllDay: boolean) => {
  if (eventType === 'birthday' || eventType === 'anniversary') {
    return false;
  }

  return !isAllDayEvent(eventType, partySubtype, eventAllDay);
};

const resolveEventEndDateTime = (eventStartDateTime: Date, eventEndDateTime?: Date | null) => {
  if (eventEndDateTime instanceof Date && Number.isFinite(eventEndDateTime.getTime())) {
    return eventEndDateTime;
  }

  return getDefaultEndDate(eventStartDateTime);
};

const isAnnualEventType = (eventType: EventTypeValue, partySubtype: PartySubtypeValue) => (
  eventType === 'birthday'
  || eventType === 'anniversary'
  || (eventType === 'party' && (partySubtype === 'birthday' || partySubtype === 'anniversary'))
);

const withSafeYear = (source: Date, year: number) => {
  const month = source.getMonth();
  const day = source.getDate();
  const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
  const safeDay = Math.min(day, daysInTargetMonth);
  const result = new Date(source);
  result.setFullYear(year, month, safeDay);
  return result;
};

const buildNextYearBirthdayOrAnniversaryEvent = (
  event: SpecialDateEvent,
  reminderTime: { hour: number; minute: number },
) => {
  // Use UTC-component-aware local date so events stored as UTC midnight
  // (or local midnight) both resolve to the correct calendar day.
  const currentEventDate = isAllDaySpecialDateEvent(event)
    ? getLocalDateFromUtcDay(event.eventDateTime)
    : new Date(event.eventDateTime);
  const nextEventDate = withSafeYear(currentEventDate, currentEventDate.getFullYear() + 1);
  if (isAllDaySpecialDateEvent(event)) {
    nextEventDate.setHours(0, 0, 0, 0);
  }

  const nextDefaultReminders = buildDefaultReminderDrafts(
    nextEventDate,
    event.notes || '',
    event.people,
    event.title,
    reminderTime,
  );

  const nextVariableReminders: VariableReminderEntry[] = nextDefaultReminders.map((item) => ({
    id: item.id,
    reminderDateTime: item.reminderDateTime,
    notes: item.notes,
  }));

  const fallbackReminderDate = new Date(nextEventDate);
  fallbackReminderDate.setHours(reminderTime.hour, reminderTime.minute, 0, 0);

  return {
    ...event,
    eventDateTime: nextEventDate.toISOString(),
    reminderMode: 'default' as const,
    frequency: 'once' as ReminderFrequency,
    reminderDateTime: nextVariableReminders[0]?.reminderDateTime || fallbackReminderDate.toISOString(),
    variableReminders: nextVariableReminders,
    notified: false,
    lastReminderTriggeredAt: undefined,
    ageAsOfToday: typeof event.ageAsOfToday === 'number' && Number.isFinite(event.ageAsOfToday)
      ? event.ageAsOfToday + 1
      : event.ageAsOfToday,
  };
};

const getNextAnnualOccurrenceDate = (source: Date, allDay: boolean) => {
  const candidate = new Date(source);
  if (allDay) {
    candidate.setHours(0, 0, 0, 0);
  }

  const now = new Date();
  if (allDay) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (candidate.getTime() >= today.getTime()) {
      return candidate;
    }

    let nextOccurrence = withSafeYear(candidate, now.getFullYear());
    nextOccurrence.setHours(0, 0, 0, 0);

    if (nextOccurrence.getTime() < today.getTime()) {
      nextOccurrence = withSafeYear(candidate, now.getFullYear() + 1);
      nextOccurrence.setHours(0, 0, 0, 0);
    }

    return nextOccurrence;
  }

  if (candidate.getTime() >= now.getTime()) {
    return candidate;
  }

  let nextOccurrence = withSafeYear(candidate, now.getFullYear());
  if (allDay) {
    nextOccurrence.setHours(0, 0, 0, 0);
  }

  if (nextOccurrence.getTime() < now.getTime()) {
    nextOccurrence = withSafeYear(candidate, now.getFullYear() + 1);
    if (allDay) {
      nextOccurrence.setHours(0, 0, 0, 0);
    }
  }

  return nextOccurrence;
};

const getDefaultReminderAnchorDate = (eventDate: Date, isAnnualEvent: boolean, allDay: boolean) => {
  const baseDate = isAnnualEvent
    ? getNextAnnualOccurrenceDate(new Date(eventDate), allDay)
    : new Date(eventDate);

  if (!isAnnualEvent) {
    return baseDate;
  }

  const today = new Date();
  const sameDateAsToday = (
    baseDate.getFullYear() === today.getFullYear()
    && baseDate.getMonth() === today.getMonth()
    && baseDate.getDate() === today.getDate()
  );

  if (!sameDateAsToday) {
    return baseDate;
  }

  const nextYearDate = withSafeYear(baseDate, baseDate.getFullYear() + 1);
  if (allDay) {
    nextYearDate.setHours(0, 0, 0, 0);
  }
  return nextYearDate;
};

const REMINDER_VISIBILITY_GRACE_MS = 2 * 60 * 1000;

const isEventExpired = (event: SpecialDateEvent) => {
  if (isBirthdayEvent(event)) {
    return false;
  }

  const reminderCandidates = getReminderCandidates(event);
  if (reminderCandidates.some((candidate) => new Date(candidate.reminderDateTime).getTime() >= Date.now() - REMINDER_VISIBILITY_GRACE_MS)) {
    return false;
  }

  return new Date(event.eventDateTime).getTime() < Date.now();
};

const getOccurrenceForNow = (event: SpecialDateEvent, now: Date) => {
  const reminderDate = new Date(event.reminderDateTime);
  const baseDate = new Date(now);
  baseDate.setSeconds(0, 0);
  baseDate.setHours(reminderDate.getHours(), reminderDate.getMinutes(), 0, 0);

  switch (event.frequency) {
    case 'once':
      return baseDate;
    case 'daily':
      return baseDate;
    case 'weekly': {
      if (baseDate.getDay() !== reminderDate.getDay()) {
        return null;
      }
      return baseDate;
    }
    case 'monthly': {
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = Math.min(reminderDate.getDate(), daysInMonth);
      baseDate.setDate(dayOfMonth);
      if (baseDate.getDate() !== dayOfMonth) {
        return null;
      }
      return baseDate;
    }
    case 'yearly': {
      const targetMonth = reminderDate.getMonth();
      const targetDay = reminderDate.getDate();
      const dayInMonth = new Date(now.getFullYear(), targetMonth + 1, 0).getDate();
      const safeDay = Math.min(targetDay, dayInMonth);
      baseDate.setFullYear(now.getFullYear(), targetMonth, safeDay);
      if (baseDate.getMonth() !== targetMonth || baseDate.getDate() !== safeDay) {
        return null;
      }
      return baseDate;
    }
    default:
      return new Date(event.reminderDateTime);
  }
};

const getNextReminderOccurrence = (event: SpecialDateEvent, fromDate: Date) => {
  const reminderDate = new Date(event.reminderDateTime);
  const baseDate = new Date(fromDate);
  baseDate.setSeconds(0, 0);
  baseDate.setHours(reminderDate.getHours(), reminderDate.getMinutes(), 0, 0);

  switch (event.frequency) {
    case 'once':
      return new Date(reminderDate);
    case 'daily': {
      const nextDate = new Date(baseDate);
      nextDate.setDate(baseDate.getDate() + 1);
      return nextDate;
    }
    case 'weekly': {
      const nextDate = new Date(baseDate);
      nextDate.setDate(baseDate.getDate() + 7);
      return nextDate;
    }
    case 'monthly': {
      const nextDate = new Date(baseDate);
      const targetDay = reminderDate.getDate();
      const nextMonth = baseDate.getMonth() + 1;
      const daysInNextMonth = new Date(baseDate.getFullYear(), nextMonth + 1, 0).getDate();
      const safeDay = Math.min(targetDay, daysInNextMonth);
      nextDate.setFullYear(baseDate.getFullYear(), nextMonth, safeDay);
      if (nextDate.getMonth() !== nextMonth) {
        nextDate.setDate(0);
      }
      return nextDate;
    }
    case 'yearly': {
      const nextDate = new Date(baseDate);
      nextDate.setFullYear(baseDate.getFullYear() + 1);
      return nextDate;
    }
    default:
      return new Date(event.reminderDateTime);
  }
};

const getNextReminderOccurrenceForEvent = (event: SpecialDateEvent, fromDate: Date) => {
  if (getReminderModeValue(event) === 'none') {
    return new Date(event.reminderDateTime);
  }

  if (event.variableReminders?.length) {
    return (event.variableReminders || [])
      .map((entry) => new Date(entry.reminderDateTime))
      .filter((occurrence) => occurrence.getTime() > fromDate.getTime())
      .sort((left, right) => left.getTime() - right.getTime())[0] || new Date(event.reminderDateTime);
  }

  const reminderDate = new Date(event.reminderDateTime);
  const baseFrom = new Date(fromDate);
  baseFrom.setSeconds(0, 0);
  baseFrom.setHours(reminderDate.getHours(), reminderDate.getMinutes(), 0, 0);

  let candidate = new Date(baseFrom);

  if (event.frequency === 'once') {
    return new Date(reminderDate);
  }

  if (event.lastReminderTriggeredAt) {
    const lastTriggeredAt = new Date(event.lastReminderTriggeredAt);
    const lastTriggeredOccurrence = new Date(lastTriggeredAt);
    lastTriggeredOccurrence.setHours(reminderDate.getHours(), reminderDate.getMinutes(), 0, 0);

    if (lastTriggeredOccurrence.getTime() >= candidate.getTime()) {
      candidate = lastTriggeredOccurrence;
    }
  }

  while (candidate.getTime() <= fromDate.getTime()) {
    switch (event.frequency) {
      case 'daily':
        candidate.setDate(candidate.getDate() + 1);
        break;
      case 'weekly':
        candidate.setDate(candidate.getDate() + 7);
        break;
      case 'monthly': {
        const targetDay = reminderDate.getDate();
        const nextMonth = candidate.getMonth() + 1;
        const nextYear = candidate.getFullYear() + (nextMonth === 12 ? 1 : 0);
        const safeMonth = nextMonth % 12;
        const daysInNextMonth = new Date(nextYear, safeMonth + 1, 0).getDate();
        const safeDay = Math.min(targetDay, daysInNextMonth);
        candidate.setFullYear(nextYear, safeMonth, safeDay);
        if (candidate.getMonth() !== safeMonth) {
          candidate.setDate(0);
        }
        break;
      }
      case 'yearly':
        candidate.setFullYear(candidate.getFullYear() + 1);
        break;
      default:
        candidate = new Date(reminderDate);
        break;
    }
  }

  return candidate;
};

const advanceOccurrenceForEvent = (event: SpecialDateEvent, occurrence: Date) => {
  const nextDate = new Date(occurrence);

  switch (event.frequency) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1);
      return nextDate;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      return nextDate;
    case 'monthly': {
      const targetDay = occurrence.getDate();
      const nextMonth = occurrence.getMonth() + 1;
      const nextYear = occurrence.getFullYear() + (nextMonth === 12 ? 1 : 0);
      const safeMonth = nextMonth % 12;
      const daysInNextMonth = new Date(nextYear, safeMonth + 1, 0).getDate();
      const safeDay = Math.min(targetDay, daysInNextMonth);
      nextDate.setFullYear(nextYear, safeMonth, safeDay);
      if (nextDate.getMonth() !== safeMonth) {
        nextDate.setDate(0);
      }
      return nextDate;
    }
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      return nextDate;
    default:
      return new Date(occurrence);
  }
};

const getUpcomingOccurrencesForEvent = (event: SpecialDateEvent, fromDate: Date, count = 730) => {
  const reminderMode = getReminderModeValue(event);
  if (reminderMode === 'none') {
    return [];
  }

  const reminderVisibilityThreshold = fromDate.getTime() - REMINDER_VISIBILITY_GRACE_MS;

  const variableOccurrences = (event.variableReminders || [])
    .map((entry) => new Date(entry.reminderDateTime))
    .filter((occurrence) => occurrence.getTime() >= reminderVisibilityThreshold)
    .sort((left, right) => left.getTime() - right.getTime());

  const getStaticOccurrences = () => {
    if (event.frequency === 'once') {
      const occurrence = getNextReminderOccurrenceForEvent(event, fromDate);
      return occurrence.getTime() > fromDate.getTime() ? [occurrence] : [];
    }

    const occurrences: Date[] = [];
    let nextOccurrence = getNextReminderOccurrenceForEvent(event, fromDate);
    const eventDate = new Date(event.eventDateTime);
    const eventDateBoundary = new Date(eventDate);
    eventDateBoundary.setHours(23, 59, 59, 999);

    if (eventDateBoundary.getTime() < fromDate.getTime()) {
      eventDateBoundary.setTime(fromDate.getTime());
      eventDateBoundary.setFullYear(eventDateBoundary.getFullYear() + 2);
    }

    while (occurrences.length < count) {
      if (nextOccurrence.getTime() < reminderVisibilityThreshold) {
        break;
      }

      if (nextOccurrence.getTime() > eventDateBoundary.getTime()) {
        break;
      }

      occurrences.push(nextOccurrence);
      nextOccurrence = advanceOccurrenceForEvent(event, nextOccurrence);
    }

    return occurrences;
  };

  if (reminderMode === 'variable') {
    return variableOccurrences.slice(0, count);
  }

  if (reminderMode === 'default') {
    if (variableOccurrences.length) {
      return variableOccurrences.slice(0, count);
    }

    const fallbackOccurrence = getNextReminderOccurrenceForEvent(event, fromDate);
    return fallbackOccurrence.getTime() >= reminderVisibilityThreshold ? [fallbackOccurrence] : [];
  }

  const staticOccurrences = getStaticOccurrences();
  if (!variableOccurrences.length) {
    return staticOccurrences.slice(0, count);
  }

  return dedupeDateOccurrences([...staticOccurrences, ...variableOccurrences]).slice(0, count);
};

const getOccurrenceKey = (event: SpecialDateEvent, occurrence: Date) => {
  switch (event.frequency) {
    case 'daily':
      return `${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, '0')}-${String(occurrence.getDate()).padStart(2, '0')}`;
    case 'weekly': {
      const startOfYear = new Date(occurrence.getFullYear(), 0, 1);
      const dayOffset = Math.floor((occurrence.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      const weekNumber = Math.floor(dayOffset / 7) + 1;
      return `${occurrence.getFullYear()}-w${weekNumber}`;
    }
    case 'monthly':
      return `${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, '0')}`;
    case 'yearly':
      return `${occurrence.getFullYear()}`;
    default:
      return `${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, '0')}-${String(occurrence.getDate()).padStart(2, '0')}`;
  }
};

const shouldTriggerReminder = (event: SpecialDateEvent, now: Date) => {
  if (isEventExpired(event)) {
    return false;
  }

  const occurrence = getOccurrenceForNow(event, now);
  if (!occurrence) {
    return false;
  }

  if (now.getTime() < occurrence.getTime()) {
    return false;
  }

  if (event.frequency === 'once') {
    return !event.notified;
  }

  if (!event.lastReminderTriggeredAt) {
    return true;
  }

  const lastTriggeredAt = new Date(event.lastReminderTriggeredAt);
  const lastOccurrenceKey = getOccurrenceKey(event, lastTriggeredAt);
  const currentOccurrenceKey = getOccurrenceKey(event, occurrence);

  return lastOccurrenceKey !== currentOccurrenceKey;
};

const getReminderModeValue = (event: SpecialDateEvent) => event.reminderMode ?? (event.variableReminders?.length ? 'variable' : 'static');

const isFutureReminderDateTime = (value: string) => new Date(value).getTime() > Date.now();

const hasMidnightTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.getHours() === 0 && date.getMinutes() === 0;
};

const dedupeDateOccurrences = (occurrences: Date[]) => {
  const seen = new Set<number>();
  return occurrences
    .sort((left, right) => left.getTime() - right.getTime())
    .filter((occurrence) => {
      const time = occurrence.getTime();
      if (seen.has(time)) {
        return false;
      }
      seen.add(time);
      return true;
    });
};

const getReminderCandidates = (event: SpecialDateEvent): ReminderCandidate[] => {
  const reminderMode = getReminderModeValue(event);
  if (reminderMode === 'none') {
    return [];
  }

  const variableCandidates = (event.variableReminders || []).map((entry) => ({
    event,
    entry,
    reminderDateTime: entry.reminderDateTime,
    entryId: entry.id,
  }));

  const staticCandidate = {
    event,
    entry: null,
    reminderDateTime: event.reminderDateTime,
    entryId: event.id,
  };

  if (reminderMode === 'variable') {
    return variableCandidates;
  }

  if (reminderMode === 'default') {
    return variableCandidates.length ? variableCandidates : [staticCandidate];
  }

  const candidatesByTime = new Map<number, ReminderCandidate>();
  [staticCandidate, ...variableCandidates].forEach((candidate) => {
    const time = new Date(candidate.reminderDateTime).getTime();
    const existing = candidatesByTime.get(time);
    if (!existing || candidate.entry) {
      candidatesByTime.set(time, candidate);
    }
  });

  return [...candidatesByTime.values()].sort((left, right) => (
    new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime()
  ));
};

export interface ContactBirthdayImport {
  contactName: string;
  birthDate: string;
}

interface AppContentProps {
  userId?: string;
  userEmail?: string;
  defaultReminderTimeZone?: string;
  pendingBirthdayImports?: ContactBirthdayImport[];
  onBirthdayImportsProcessed?: () => void;
  onRequestGroupRename?: (groupId: string) => void;
}

interface ShareContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mobileNumber?: string;
  photo?: string;
  deletedAt: string | null;
}

interface ShareGroup {
  id: string;
  name: string;
  contactIds: string[];
}

interface ShareRecipient {
  key: string;
  label: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source: 'contact' | 'group' | 'manual-email' | 'manual-phone';
}

const getContactsStorageKey = (userId: string) => `special-date-contacts:${userId}`;

const normalizeShareContactsSnapshot = (raw: string | null): { contacts: ShareContact[]; groups: ShareGroup[] } => {
  if (!raw) {
    return { contacts: [], groups: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<{ contacts: ShareContact[]; groups: ShareGroup[] }> | ShareContact[];
    const parsedContacts = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.contacts)
        ? parsed.contacts
        : [];
    const parsedGroups = !Array.isArray(parsed) && Array.isArray(parsed.groups)
      ? parsed.groups
      : [];

    const contacts = parsedContacts
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const candidate = entry as Partial<ShareContact> & { fullName?: string };
        const id = String(candidate.id || '').trim();
        const email = String(candidate.email || '').trim().toLowerCase();
        const fullName = String(candidate.fullName || '').trim();
        const fallbackParts = fullName ? fullName.split(/\s+/).filter(Boolean) : [];
        const firstName = String(candidate.firstName || fallbackParts[0] || '').trim();
        const lastName = String(candidate.lastName || fallbackParts.slice(1).join(' ') || '').trim();

        if (!id || (!email && !candidate.mobileNumber) || !firstName) {
          return null;
        }

        return {
          id,
          email,
          firstName,
          lastName,
          mobileNumber: candidate.mobileNumber ? String(candidate.mobileNumber).trim() : '',
          photo: candidate.photo ? String(candidate.photo) : undefined,
          deletedAt: candidate.deletedAt ? String(candidate.deletedAt) : null,
        } as ShareContact;
      })
      .filter((entry): entry is ShareContact => entry !== null && !entry.deletedAt);

    const groups = parsedGroups
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const candidate = entry as Partial<ShareGroup>;
        const id = String(candidate.id || '').trim();
        const name = String(candidate.name || '').trim();
        if (!id || !name) {
          return null;
        }

        return {
          id,
          name,
          contactIds: Array.isArray(candidate.contactIds) ? candidate.contactIds.map((contactId) => String(contactId || '').trim()).filter(Boolean) : [],
        } as ShareGroup;
      })
      .filter((entry): entry is ShareGroup => entry !== null);

    return { contacts, groups };
  } catch (error) {
    console.warn('Unable to parse share contacts snapshot', error);
    return { contacts: [], groups: [] };
  }
};

interface SavedEventLocation {
  id: string;
  name: string;
  placeId?: string;
  formattedAddress?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  updatedAt: string;
}

const getEventLocationsStorageKey = (userId: string) => `special-date-locations:${userId}`;

const normalizeSavedEventLocationsSnapshot = (raw: string | null): SavedEventLocation[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const candidate = entry as Partial<SavedEventLocation>;
        const id = String(candidate.id || '').trim();
        const name = String(candidate.name || '').trim();
        if (!id || !name) {
          return null;
        }

        return {
          id,
          name,
          placeId: candidate.placeId ? String(candidate.placeId) : undefined,
          formattedAddress: candidate.formattedAddress ? String(candidate.formattedAddress) : undefined,
          line1: candidate.line1 ? String(candidate.line1) : undefined,
          line2: candidate.line2 ? String(candidate.line2) : undefined,
          city: candidate.city ? String(candidate.city) : undefined,
          state: candidate.state ? String(candidate.state) : undefined,
          zip: candidate.zip ? String(candidate.zip) : undefined,
          phone: candidate.phone ? String(candidate.phone) : undefined,
          updatedAt: candidate.updatedAt ? String(candidate.updatedAt) : new Date().toISOString(),
        } as SavedEventLocation;
      })
      .filter((entry): entry is SavedEventLocation => entry !== null);
  } catch (error) {
    console.warn('Unable to parse saved event locations', error);
    return [];
  }
};

export default function AppContent({ userId, userEmail, defaultReminderTimeZone, pendingBirthdayImports, onBirthdayImportsProcessed, onRequestGroupRename }: AppContentProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createAppContentStyles(colors), [colors]);
  const { height: windowHeight } = useWindowDimensions();
  const summaryPageSize = Math.max(5, Math.floor((windowHeight - 310) / 60));
  const apiStorageEnabled = isApiStorageEnabled();
  const effectiveReminderTimeZone = defaultReminderTimeZone || DEVICE_TIME_ZONE;
  const [events, setEvents] = useState<SpecialDateEvent[]>([]);
  const [hasLoadedInitialEvents, setHasLoadedInitialEvents] = useState(false);
  const [form, setForm] = useState(() => getResetFormState(effectiveReminderTimeZone));
  const [hasSelectedEventType, setHasSelectedEventType] = useState(false);
  const [isEventTypePickerVisible, setIsEventTypePickerVisible] = useState(false);
  const [isAddRemindersPromptVisible, setIsAddRemindersPromptVisible] = useState(false);
  const [pendingNoReminderSave, setPendingNoReminderSave] = useState(false);
  const [eventTypeDraft, setEventTypeDraft] = useState<EventTypeValue | ''>('');
  const [hasSelectedSubtype, setHasSelectedSubtype] = useState(false);
  const [isSubtypePickerVisible, setIsSubtypePickerVisible] = useState(false);
  const [subtypeDraft, setSubtypeDraft] = useState('');
  const [isVoiceEventModalVisible, setIsVoiceEventModalVisible] = useState(false);
  const [voiceTranscriptDraft, setVoiceTranscriptDraft] = useState('');
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [isParsingVoiceEvent, setIsParsingVoiceEvent] = useState(false);

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results?.[0]?.transcript;
    if (typeof transcript === 'string') {
      setVoiceTranscriptDraft(transcript);
    }
  });
  useSpeechRecognitionEvent('end', () => {
    setIsVoiceRecording(false);
  });
  useSpeechRecognitionEvent('error', (event) => {
    setIsVoiceRecording(false);
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      Alert.alert('Speech recognition error', event.message || 'Please try again.');
    }
  });
  const [pickerTarget, setPickerTarget] = useState<'event' | 'reminder' | null>(null);
  const [pickerMonth, setPickerMonth] = useState(new Date());
  const [activeTimePicker, setActiveTimePicker] = useState<{ target: TimePickerTarget; title: string } | null>(null);
  const [timePickerDraftDate, setTimePickerDraftDate] = useState<Date>(getDefaultDate());
  const [activeReminder, setActiveReminder] = useState<SpecialDateEvent | null>(null);
  const [editingEvent, setEditingEvent] = useState<SpecialDateEvent | null>(null);
  const [confirmCancelEventId, setConfirmCancelEventId] = useState<string | null>(null);
  const [confirmDeleteReminder, setConfirmDeleteReminder] = useState<{
    eventId: string;
    reminderEntryId?: string;
    reminderSource?: 'static' | 'variable';
    target: 'reminder' | 'event' | 'all-reminders';
  } | null>(null);
  const [isDeletingConfirmedItem, setIsDeletingConfirmedItem] = useState(false);
  const [isDeletingConfirmedEvent, setIsDeletingConfirmedEvent] = useState(false);
  const [remindersForEventId, setRemindersForEventId] = useState<string | null>(null);
  const [remindersModalPage, setRemindersModalPage] = useState(0);
  const [currentView, setCurrentView] = useState<'create' | 'create-reminders' | 'share' | 'manage-events' | 'manage-reminders'>('manage-events');
  const [calendarDefaults, setCalendarDefaults] = useState<CalendarDefaultsSettings>(DEFAULT_CALENDAR_DEFAULTS_SETTINGS);
  const [landingTickerVersion, setLandingTickerVersion] = useState(0);
  const previousViewRef = useRef(currentView);
  const [viewVersion, setViewVersion] = useState(0);
  const [pendingVariableReminders, setPendingVariableReminders] = useState<SpecialDateEvent[]>([]);
  const [seededVariableDraftIds, setSeededVariableDraftIds] = useState<string[]>([]);
  const [pendingReminderDateTime, setPendingReminderDateTime] = useState<Date>(new Date(0));
  const [pendingReminderMonth, setPendingReminderMonth] = useState<Date>(getDefaultDate());
  const [staticReminderMonth, setStaticReminderMonth] = useState<Date>(getDefaultDate());
  const [isStaticReminderTimeSelected, setIsStaticReminderTimeSelected] = useState(false);
  const [isVariableReminderTimeSelected, setIsVariableReminderTimeSelected] = useState(false);
  const [isReminderAddedFlash, setIsReminderAddedFlash] = useState(false);
  const [hasTouchedStaticReminderSchedule, setHasTouchedStaticReminderSchedule] = useState(false);
  const [savedEventsView, setSavedEventsView] = useState<'list' | 'calendar' | 'summary'>('summary');
  const [savedRemindersView, setSavedRemindersView] = useState<'list' | 'calendar' | 'summary'>('summary');
  const [isManageEventsVisible, setIsManageEventsVisible] = useState(false);
  const [isManageRemindersVisible, setIsManageRemindersVisible] = useState(false);
  const [savedEventsFilterTypes, setSavedEventsFilterTypes] = useState<SavedEventsFilterType[]>([]);
  const [savedEventsFilterSubtype, setSavedEventsFilterSubtype] = useState<string>('all');
  const [isSavedEventsTypeFilterVisible, setIsSavedEventsTypeFilterVisible] = useState(false);
  const [isSavedEventsSubtypeFilterVisible, setIsSavedEventsSubtypeFilterVisible] = useState(false);
  const [savedEventsSummaryPage, setSavedEventsSummaryPage] = useState(0);
  const [savedRemindersSummaryPage, setSavedRemindersSummaryPage] = useState(0);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
  const [expandedCalendarEventId, setExpandedCalendarEventId] = useState<string | null>(null);
  const [selectedReminderCalendarDate, setSelectedReminderCalendarDate] = useState<Date | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date());
  const [savedRemindersCalendarMonth, setSavedRemindersCalendarMonth] = useState<Date>(new Date());
  const [selectedReminderPopup, setSelectedReminderPopup] = useState<Date | null>(null);
  const [selectedReminderDetail, setSelectedReminderDetail] = useState<{ eventId: string; occurrenceTime: number } | null>(null);
  const [selectedEventPopupDate, setSelectedEventPopupDate] = useState<Date | null>(null);
  const [selectedSummaryEventId, setSelectedSummaryEventId] = useState<string | null>(null);
  const [reminderPage, setReminderPage] = useState(0);
  const [savedEventsPage, setSavedEventsPage] = useState(0);
  const [savedRemindersPage, setSavedRemindersPage] = useState(0);
  const [isRefreshingSavedData, setIsRefreshingSavedData] = useState(false);
  const [isSavingEvent, setIsSavingEvent] = useState(false);
  const [hoveredReminderMode, setHoveredReminderMode] = useState<ReminderModeValue | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [apiStorageStatusMessage, setApiStorageStatusMessage] = useState<string | null>(null);
  const [reminderDeliveryDeviceEnabled, setReminderDeliveryDeviceEnabled] = useState(true);
  const tickerStartX = Dimensions.get('window').width;
  const nextEventTickerX = useRef(new Animated.Value(tickerStartX)).current;
  const nextReminderTickerX = useRef(new Animated.Value(tickerStartX)).current;
  const [nextEventTickerTextWidth, setNextEventTickerTextWidth] = useState(0);
  const [nextReminderTickerTextWidth, setNextReminderTickerTextWidth] = useState(0);
  const [reminderDeliveryEmailEnabled, setReminderDeliveryEmailEnabled] = useState(false);
  const [reminderDeliveryTextEnabled, setReminderDeliveryTextEnabled] = useState(false);
  const [reminderSoundEnabled, setReminderSoundEnabled] = useState(true);
  const [defaultReminderTime, setDefaultReminderTime] = useState<ReminderDefaultTimeSettings>({ hour: 9, minute: 0, clockIntervalMinutes: 5 });
  const [sharingEvent, setSharingEvent] = useState<SpecialDateEvent | null>(null);
  const [shareContacts, setShareContacts] = useState<ShareContact[]>([]);
  const [shareGroups, setShareGroups] = useState<ShareGroup[]>([]);
  const [shareQuickAddPanel, setShareQuickAddPanel] = useState<'contact' | 'group' | null>(null);
  const [shareContactSearch, setShareContactSearch] = useState('');
  const [shareManualEmail, setShareManualEmail] = useState('');
  const [shareManualPhone, setShareManualPhone] = useState('');
  const [shareRecipients, setShareRecipients] = useState<ShareRecipient[]>([]);
  const [shareMessage, setShareMessage] = useState('');
  const [isSendingShare, setIsSendingShare] = useState(false);
  const [isRsvpDatePickerVisible, setIsRsvpDatePickerVisible] = useState(false);
  const [isConfirmingRsvpByDate, setIsConfirmingRsvpByDate] = useState(false);
  const [rsvpByDateDraft, setRsvpByDateDraft] = useState<Date>(new Date());
  const [rsvpPickerMonth, setRsvpPickerMonth] = useState<Date>(new Date());
  const [rsvpSummaries, setRsvpSummaries] = useState<Record<string, RsvpSummaryResult>>({});
  const [rsvpManagerEventId, setRsvpManagerEventId] = useState<string | null>(null);
  const [sendingRsvpReminderId, setSendingRsvpReminderId] = useState<string | null>(null);
  const [pendingRsvpGroupPrompt, setPendingRsvpGroupPrompt] = useState<{ groupId: string; groupName: string } | null>(null);
  const [hasInitializedReminderScheduleView, setHasInitializedReminderScheduleView] = useState(false);
  const [pendingShareInvites, setPendingShareInvites] = useState<PendingShareInvite[]>([]);
  const [activeShareInvite, setActiveShareInvite] = useState<PendingShareInvite | null>(null);
  const [isRespondingToShareInvite, setIsRespondingToShareInvite] = useState(false);
  const [interruptedModalContext, setInterruptedModalContext] = useState<{
    remindersForEventId: string | null;
    selectedEventPopupDate: Date | null;
    selectedReminderPopup: Date | null;
    selectedReminderCalendarDate: Date | null;
    reminderPage: number;
  } | null>(null);
  const latestModalContextRef = useRef<{
    remindersForEventId: string | null;
    selectedEventPopupDate: Date | null;
    selectedReminderPopup: Date | null;
    selectedReminderCalendarDate: Date | null;
    reminderPage: number;
  }>({
    remindersForEventId: null,
    selectedEventPopupDate: null,
    selectedReminderPopup: null,
    selectedReminderCalendarDate: null,
    reminderPage: 0,
  });
  const refreshInFlightRef = useRef(false);
  const eventsRef = useRef(events);
  const isProcessingBirthdayImportsRef = useRef(false);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    setRemindersModalPage(0);
  }, [remindersForEventId]);

  const shareSelectableContacts = useMemo(
    () => shareContacts
      .filter((contact) => !contact.deletedAt)
      .slice()
      .sort((a, b) => {
        const aKey = (a.lastName || a.firstName || '').trim().toLowerCase();
        const bKey = (b.lastName || b.firstName || '').trim().toLowerCase();
        return aKey.localeCompare(bKey);
      }),
    [shareContacts],
  );
  const filteredShareSelectableContacts = useMemo(() => {
    const query = shareContactSearch.trim().toLowerCase();
    if (!query) {
      return shareSelectableContacts;
    }

    return shareSelectableContacts.filter((contact) => {
      const fullName = `${contact.firstName} ${contact.lastName}`.trim().toLowerCase();
      const email = (contact.email || '').toLowerCase();
      const phone = (contact.mobileNumber || '').toLowerCase();
      return fullName.includes(query) || email.includes(query) || phone.includes(query);
    });
  }, [shareSelectableContacts, shareContactSearch]);
  const contactPhotoByNameKey = useMemo(() => {
    const map = new Map<string, string>();
    shareContacts.forEach((contact) => {
      if (contact.deletedAt || !contact.photo) {
        return;
      }
      const fullName = `${contact.firstName} ${contact.lastName}`.trim().toLowerCase();
      if (fullName && !map.has(fullName)) {
        map.set(fullName, contact.photo);
      }
      const firstOnly = contact.firstName.trim().toLowerCase();
      if (!contact.lastName.trim() && firstOnly && !map.has(firstOnly)) {
        map.set(firstOnly, contact.photo);
      }
    });
    return map;
  }, [shareContacts]);

  const getEventContactPhoto = (event: SpecialDateEvent): string | undefined => (
    contactPhotoByNameKey.get(event.people.trim().toLowerCase())
  );

  const renderEventSummaryIcon = (event: SpecialDateEvent) => {
    const contactPhoto = getEventContactPhoto(event);
    if (contactPhoto) {
      return <Image source={{ uri: contactPhoto }} style={styles.summaryLinkPhoto} />;
    }
    return <Text style={styles.summaryLinkIcon}>{getEventSummaryIcon(event)}</Text>;
  };
  const activeClockIntervalMinutes = useMemo(
    () => normalizeClockIntervalMinutes(defaultReminderTime.clockIntervalMinutes),
    [defaultReminderTime.clockIntervalMinutes],
  );
  const [eventLocationPredictions, setEventLocationPredictions] = useState<GoogleAddressPrediction[]>([]);
  const [isEventLocationLine1Focused, setIsEventLocationLine1Focused] = useState(false);
  const [eventLocationAutocompleteSessionToken] = useState(() => `event-addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const skipNextEventLocationAutocompleteFetchRef = useRef(0);
  const eventLocationBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedEventLocations, setSavedEventLocations] = useState<SavedEventLocation[]>([]);
  const [isEventLocationNameFocused, setIsEventLocationNameFocused] = useState(false);
  const eventLocationNameBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTypeSelectionUi = useCallback(() => {
    setHasSelectedEventType(false);
    setIsEventTypePickerVisible(false);
    setEventTypeDraft('');
    setHasSelectedSubtype(false);
    setIsSubtypePickerVisible(false);
    setSubtypeDraft('');
  }, []);

  useEffect(() => () => {
    if (eventLocationBlurTimeoutRef.current) {
      clearTimeout(eventLocationBlurTimeoutRef.current);
    }
    if (eventLocationNameBlurTimeoutRef.current) {
      clearTimeout(eventLocationNameBlurTimeoutRef.current);
    }
  }, []);

  const collapseTypeSelectionUiForEdit = useCallback((eventType: EventTypeValue, subtypeValue: string) => {
    setHasSelectedEventType(true);
    setIsEventTypePickerVisible(false);
    setEventTypeDraft(eventType);
    setHasSelectedSubtype(eventTypeHasSubtype(eventType));
    setIsSubtypePickerVisible(false);
    setSubtypeDraft(subtypeValue);
  }, []);

  const repairLegacyReminderTimes = useCallback((items: SpecialDateEvent[]) => {
    let changed = false;

    const repaired = items.map((event) => {
      const reminderMode = getReminderModeValue(event);
      if (reminderMode === 'none') {
        return event;
      }

      const hasMidnightVariableReminder = (event.variableReminders || []).some((entry) => hasMidnightTime(entry.reminderDateTime));
      const shouldRepairAllDayReminder = isAllDaySpecialDateEvent(event) && (
        event.reminderAllDay
        || hasMidnightTime(event.reminderDateTime)
        || hasMidnightVariableReminder
      );
      if (!shouldRepairAllDayReminder) {
        return event;
      }

      const reminderTimeZone = event.reminderTimeZone || effectiveReminderTimeZone;
      const nextReminderDate = getLocalDateFromUtcDay(event.reminderDateTime);
      nextReminderDate.setHours(defaultReminderTime.hour, defaultReminderTime.minute, 0, 0);
      const nextReminderDateTime = convertWallDateInTimeZoneToUtcIso(nextReminderDate, reminderTimeZone);

      const nextVariableReminders = (event.variableReminders || []).map((entry) => {
        if (!hasMidnightTime(entry.reminderDateTime)) {
          return entry;
        }

        const nextVariableDate = getLocalDateFromUtcDay(entry.reminderDateTime);
        nextVariableDate.setHours(defaultReminderTime.hour, defaultReminderTime.minute, 0, 0);
        return {
          ...entry,
          reminderDateTime: convertWallDateInTimeZoneToUtcIso(nextVariableDate, reminderTimeZone),
        };
      });

      changed = true;
      return {
        ...event,
        reminderDateTime: nextReminderDateTime,
        reminderAllDay: false,
        variableReminders: nextVariableReminders.length ? nextVariableReminders : event.variableReminders,
      };
    });

    return { events: repaired, changed };
  }, [defaultReminderTime.hour, defaultReminderTime.minute, effectiveReminderTimeZone]);

  useEffect(() => {
    setForm((current) => ({
      ...current,
      reminderTimeZone: effectiveReminderTimeZone,
    }));
  }, [effectiveReminderTimeZone]);

  useEffect(() => {
    const alignDateMinute = (date: Date) => {
      const alignedMinute = alignMinuteToClockInterval(date.getMinutes(), activeClockIntervalMinutes);
      if (alignedMinute === date.getMinutes()) {
        return date;
      }

      const nextDate = new Date(date);
      nextDate.setMinutes(alignedMinute, 0, 0);
      return nextDate;
    };

    setForm((current) => {
      const nextEventDateTime = alignDateMinute(current.eventDateTime);
      const nextReminderDateTime = alignDateMinute(current.reminderDateTime);
      const nextEventEndDateTime = current.eventEndDateTime ? alignDateMinute(current.eventEndDateTime) : null;

      const hasEventChanged = nextEventDateTime !== current.eventDateTime;
      const hasReminderChanged = nextReminderDateTime !== current.reminderDateTime;
      const hasEndChanged = nextEventEndDateTime !== current.eventEndDateTime;

      if (!hasEventChanged && !hasReminderChanged && !hasEndChanged) {
        return current;
      }

      return {
        ...current,
        eventDateTime: nextEventDateTime,
        eventEndDateTime: nextEventEndDateTime,
        reminderDateTime: nextReminderDateTime,
      };
    });

    setPendingReminderDateTime((current) => alignDateMinute(current));
  }, [activeClockIntervalMinutes]);

  const autoPushGoogleCalendarIfConfigured = useCallback(async () => {
    if (!userId) {
      return;
    }

    try {
      const syncSettings = await loadCalendarSyncSettings(userId);
      const googleConfig = syncSettings.google;

      if (!googleConfig.calendarId || googleConfig.syncPaused || googleConfig.permission !== 'write' || googleConfig.autoSyncEnabled === false) {
        return;
      }

      const result = await pushGoogleCalendarEvents(userId);
      if (!result.success || result.failed > 0) {
        const summary = result.errors?.[0] || 'Use Google Sync in Calendar Sync settings to retry.';
        setApiStorageStatusMessage(`Google Calendar auto-sync had issues: ${summary}`);
      }
    } catch (error) {
      console.warn('Google Calendar auto-sync failed', error);
      setApiStorageStatusMessage('Google Calendar auto-sync failed. Use Google Sync in Calendar Sync settings to retry.');
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    let isActive = true;

    void AsyncStorage.getItem(getContactsStorageKey(userId)).then((rawContacts) => {
      if (!isActive) {
        return;
      }

      const snapshot = normalizeShareContactsSnapshot(rawContacts);
      setShareContacts(snapshot.contacts);
      setShareGroups(snapshot.groups);
    }).catch((error) => {
      console.warn('Unable to load share contacts', error);
      if (isActive) {
        setShareContacts([]);
        setShareGroups([]);
      }
    });

    return () => {
      isActive = false;
    };
  }, [currentView, userId]);

  useEffect(() => {
    if (currentView !== 'create' || !userId) {
      return;
    }

    let isActive = true;

    void AsyncStorage.getItem(getEventLocationsStorageKey(userId)).then((raw) => {
      if (!isActive) {
        return;
      }

      setSavedEventLocations(normalizeSavedEventLocationsSnapshot(raw));
    }).catch((error) => {
      console.warn('Unable to load saved event locations', error);
      if (isActive) {
        setSavedEventLocations([]);
      }
    });

    return () => {
      isActive = false;
    };
  }, [currentView, userId]);

  const appendShareRecipients = useCallback((nextRecipients: ShareRecipient[]) => {
    setShareRecipients((current) => {
      const merged = [...current];
      nextRecipients.forEach((recipient) => {
        if (!merged.some((entry) => entry.key === recipient.key)) {
          merged.push(recipient);
        }
      });
      return merged;
    });
    setValidationMessage(null);
  }, []);

  const removeShareRecipient = useCallback((key: string) => {
    setShareRecipients((current) => current.filter((recipient) => recipient.key !== key));
  }, []);

  const addContactRecipient = useCallback((contact: ShareContact) => {
    appendShareRecipients([{
      key: `contact:${contact.id}`,
      label: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ''}`,
      firstName: contact.firstName || undefined,
      lastName: contact.lastName || undefined,
      email: contact.email || undefined,
      phone: contact.mobileNumber ? formatPhoneNumberInput(contact.mobileNumber) : undefined,
      source: 'contact',
    }]);
  }, [appendShareRecipients]);

  const addGroupRecipients = useCallback((group: ShareGroup) => {
    const groupRecipients = group.contactIds
      .map((contactId) => shareSelectableContacts.find((entry) => entry.id === contactId) || null)
      .filter((entry): entry is ShareContact => entry !== null)
      .map((contact) => ({
        key: `contact:${contact.id}`,
        label: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ''}`,
        firstName: contact.firstName || undefined,
        lastName: contact.lastName || undefined,
        email: contact.email || undefined,
        phone: contact.mobileNumber ? formatPhoneNumberInput(contact.mobileNumber) : undefined,
        source: 'group' as const,
      }));

    appendShareRecipients(groupRecipients);
  }, [appendShareRecipients, shareSelectableContacts]);

  // Automatically saves (or updates) a contacts group named after this event so re-sharing
  // an update later is a one-tap "Add Group" instead of re-picking every recipient. Reads and
  // writes the full raw contacts+groups snapshot (not the trimmed ShareContact/ShareGroup view
  // already in memory) so fields the Contacts screen owns — photo, address, favorites, etc. —
  // are never touched for existing contacts.
  const createOrUpdateRsvpShareGroup = async (event: SpecialDateEvent, recipients: ShareRecipient[]) => {
    if (!userId || !recipients.length) {
      return;
    }

    try {
      let contacts: Array<Record<string, any>> = [];
      let groups: Array<Record<string, any>> = [];
      let ownerUserId: string | undefined;
      let ownerEmail: string | undefined;
      let schemaVersion: number | undefined;

      if (isApiStorageEnabled()) {
        const remote = await loadUserContactsSnapshot(userId);
        const remoteSnapshot = remote?.snapshot as Record<string, any> | null | undefined;
        if (remoteSnapshot && typeof remoteSnapshot === 'object') {
          contacts = Array.isArray(remoteSnapshot.contacts) ? remoteSnapshot.contacts : [];
          groups = Array.isArray(remoteSnapshot.groups) ? remoteSnapshot.groups : [];
          ownerUserId = remoteSnapshot.ownerUserId;
          ownerEmail = remoteSnapshot.ownerEmail;
          schemaVersion = remoteSnapshot.schemaVersion;
        }
      }

      if (!contacts.length && !groups.length) {
        const rawLocal = await AsyncStorage.getItem(getContactsStorageKey(userId));
        if (rawLocal) {
          try {
            const parsedLocal = JSON.parse(rawLocal);
            contacts = Array.isArray(parsedLocal?.contacts)
              ? parsedLocal.contacts
              : Array.isArray(parsedLocal)
                ? parsedLocal
                : [];
            groups = Array.isArray(parsedLocal?.groups) ? parsedLocal.groups : [];
            ownerUserId = parsedLocal?.ownerUserId;
            ownerEmail = parsedLocal?.ownerEmail;
            schemaVersion = parsedLocal?.schemaVersion;
          } catch (error) {
            console.warn('Unable to parse local contacts snapshot for RSVP group', error);
          }
        }
      }

      const nowIso = new Date().toISOString();
      const nextContacts = [...contacts];
      const resolvedContactIds: string[] = [];

      recipients.forEach((recipient) => {
        let contactId = '';

        if (recipient.key.startsWith('contact:') && !recipient.key.startsWith('contact:device:')) {
          const candidateId = recipient.key.slice('contact:'.length);
          if (nextContacts.some((entry) => String(entry?.id || '') === candidateId)) {
            contactId = candidateId;
          }
        }

        const normalizedEmail = recipient.email?.trim().toLowerCase() || '';
        const normalizedPhone = recipient.phone ? recipient.phone.replace(/\D/g, '').slice(0, 10) : '';

        if (!contactId && (normalizedEmail || normalizedPhone)) {
          const matched = nextContacts.find((entry) => {
            if (entry?.deletedAt) {
              return false;
            }
            const entryEmail = String(entry?.email || '').trim().toLowerCase();
            const entryPhone = String(entry?.mobileNumber || '').replace(/\D/g, '').slice(0, 10);
            return (normalizedEmail && entryEmail === normalizedEmail) || (normalizedPhone && entryPhone === normalizedPhone);
          });
          if (matched) {
            contactId = String(matched.id);
          }
        }

        if (!contactId) {
          // recipient.label is just the raw email/phone for manual-email/manual-phone
          // recipients (there's no real name to derive), so splitting it on whitespace would
          // chop a phone number into garbage firstName/lastName fragments. Only use a real name
          // when we actually have one (saved contact, group member, or a picked device contact).
          const newContact = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            email: normalizedEmail,
            firstName: recipient.firstName || 'Guest',
            lastName: recipient.lastName || '',
            address: '',
            birthDate: '',
            mobileNumber: recipient.phone || undefined,
            company: '',
            notes: '',
            isFavorite: false,
            groupIds: [] as string[],
            createdAt: nowIso,
            updatedAt: nowIso,
            deletedAt: null,
          };
          nextContacts.push(newContact);
          contactId = newContact.id;
        }

        if (contactId && !resolvedContactIds.includes(contactId)) {
          resolvedContactIds.push(contactId);
        }
      });

      if (!resolvedContactIds.length) {
        return;
      }

      const groupName = `${event.title} • ${event.people}`.trim().slice(0, 120);
      const nextGroups = [...groups];
      // Prefer matching by sourceEventId (set on groups created from here on) so a later rename
      // still resolves correctly; fall back to matching by name for groups created before this
      // field existed.
      const existingGroupIndex = nextGroups.findIndex((entry) => (
        entry?.sourceEventId
          ? String(entry.sourceEventId) === event.id
          : String(entry?.name || '').trim().toLowerCase() === groupName.toLowerCase()
      ));

      let groupId: string;
      if (existingGroupIndex >= 0) {
        const existingGroup = nextGroups[existingGroupIndex];
        const mergedContactIds = Array.from(new Set([
          ...(Array.isArray(existingGroup.contactIds) ? existingGroup.contactIds : []),
          ...resolvedContactIds,
        ]));
        nextGroups[existingGroupIndex] = { ...existingGroup, contactIds: mergedContactIds, sourceEventId: event.id };
        groupId = String(existingGroup.id);
      } else {
        groupId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        nextGroups.push({
          id: groupId,
          name: groupName,
          description: `Guests for ${event.title}`,
          contactIds: resolvedContactIds,
          createdAt: nowIso,
          sourceEventId: event.id,
        });
      }

      const finalContacts = nextContacts.map((entry) => {
        const entryId = String(entry?.id || '');
        if (!resolvedContactIds.includes(entryId)) {
          return entry;
        }
        const currentGroupIds = Array.isArray(entry.groupIds) ? entry.groupIds : [];
        return currentGroupIds.includes(groupId)
          ? entry
          : { ...entry, groupIds: [...currentGroupIds, groupId], updatedAt: nowIso };
      });

      const payload = {
        contacts: finalContacts,
        groups: nextGroups,
        ownerUserId: ownerUserId || userId,
        ownerEmail: ownerEmail || userEmail?.trim().toLowerCase() || '',
        schemaVersion: schemaVersion || 2,
        updatedAt: nowIso,
      };

      await AsyncStorage.setItem(getContactsStorageKey(userId), JSON.stringify(payload));

      if (isApiStorageEnabled()) {
        const saveResult = await saveUserContactsSnapshot(userId, payload);
        if (!saveResult.success) {
          console.warn('Unable to save RSVP share group to backend', saveResult.error);
        }
      }

      const normalized = normalizeShareContactsSnapshot(JSON.stringify(payload));
      setShareContacts(normalized.contacts);
      setShareGroups(normalized.groups);
    } catch (error) {
      console.warn('Unable to create or update RSVP share group', error);
    }
  };

  const loadRawContactsSnapshot = async () => {
    let contacts: Array<Record<string, any>> = [];
    let groups: Array<Record<string, any>> = [];
    let ownerUserId: string | undefined;
    let ownerEmail: string | undefined;
    let schemaVersion: number | undefined;

    if (!userId) {
      return { contacts, groups, ownerUserId, ownerEmail, schemaVersion };
    }

    if (isApiStorageEnabled()) {
      const remote = await loadUserContactsSnapshot(userId);
      const remoteSnapshot = remote?.snapshot as Record<string, any> | null | undefined;
      if (remoteSnapshot && typeof remoteSnapshot === 'object') {
        contacts = Array.isArray(remoteSnapshot.contacts) ? remoteSnapshot.contacts : [];
        groups = Array.isArray(remoteSnapshot.groups) ? remoteSnapshot.groups : [];
        ownerUserId = remoteSnapshot.ownerUserId;
        ownerEmail = remoteSnapshot.ownerEmail;
        schemaVersion = remoteSnapshot.schemaVersion;
      }
    }

    if (!contacts.length && !groups.length) {
      const rawLocal = await AsyncStorage.getItem(getContactsStorageKey(userId));
      if (rawLocal) {
        try {
          const parsedLocal = JSON.parse(rawLocal);
          contacts = Array.isArray(parsedLocal?.contacts)
            ? parsedLocal.contacts
            : Array.isArray(parsedLocal)
              ? parsedLocal
              : [];
          groups = Array.isArray(parsedLocal?.groups) ? parsedLocal.groups : [];
          ownerUserId = parsedLocal?.ownerUserId;
          ownerEmail = parsedLocal?.ownerEmail;
          schemaVersion = parsedLocal?.schemaVersion;
        } catch (error) {
          console.warn('Unable to parse local contacts snapshot', error);
        }
      }
    }

    return { contacts, groups, ownerUserId, ownerEmail, schemaVersion };
  };

  const persistRawContactsSnapshot = async (snapshot: {
    contacts: Array<Record<string, any>>;
    groups: Array<Record<string, any>>;
    ownerUserId?: string;
    ownerEmail?: string;
    schemaVersion?: number;
  }) => {
    if (!userId) {
      return;
    }

    const payload = {
      contacts: snapshot.contacts,
      groups: snapshot.groups,
      ownerUserId: snapshot.ownerUserId || userId,
      ownerEmail: snapshot.ownerEmail || userEmail?.trim().toLowerCase() || '',
      schemaVersion: snapshot.schemaVersion || 2,
      updatedAt: new Date().toISOString(),
    };

    await AsyncStorage.setItem(getContactsStorageKey(userId), JSON.stringify(payload));

    if (isApiStorageEnabled()) {
      const saveResult = await saveUserContactsSnapshot(userId, payload);
      if (!saveResult.success) {
        console.warn('Unable to save contacts snapshot to backend', saveResult.error);
      }
    }

    const normalized = normalizeShareContactsSnapshot(JSON.stringify(payload));
    setShareContacts(normalized.contacts);
    setShareGroups(normalized.groups);
  };

  // Groups created for an event's RSVP carry sourceEventId going forward; older ones (created
  // before that field existed) are matched by the same "<title> • <people>" name they were
  // given at creation.
  const findRsvpGroupForEvent = async (event: SpecialDateEvent): Promise<{ id: string; name: string } | null> => {
    const snapshot = await loadRawContactsSnapshot();
    const groupName = `${event.title} • ${event.people}`.trim().toLowerCase();
    const match = snapshot.groups.find((entry) => (
      entry?.sourceEventId
        ? String(entry.sourceEventId) === event.id
        : String(entry?.name || '').trim().toLowerCase() === groupName
    ));
    return match ? { id: String(match.id), name: String(match.name || '') } : null;
  };

  const deleteRsvpGroup = async (groupId: string) => {
    const snapshot = await loadRawContactsSnapshot();
    const nextGroups = snapshot.groups.filter((entry) => String(entry?.id || '') !== groupId);
    const nextContacts = snapshot.contacts.map((entry) => {
      const groupIds = Array.isArray(entry?.groupIds) ? entry.groupIds : [];
      if (!groupIds.includes(groupId)) {
        return entry;
      }
      return {
        ...entry,
        groupIds: groupIds.filter((id: string) => id !== groupId),
        updatedAt: new Date().toISOString(),
      };
    });

    await persistRawContactsSnapshot({ ...snapshot, contacts: nextContacts, groups: nextGroups });
  };

  const pickDeviceContactForShare = useCallback(async () => {
    if (Platform.OS === 'web') {
      setValidationMessage('Device contacts are not available in the web build. Use an iPhone or iPad app build.');
      return;
    }

    try {
      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        setValidationMessage('Allow Contacts access on your iPhone to add a contact to this share.');
        return;
      }

      const selectedContact = await Contacts.presentContactPickerAsync();
      if (!selectedContact) {
        return;
      }

      const fullContact = selectedContact.id
        ? await Contacts.getContactByIdAsync(String(selectedContact.id), [
            Contacts.Fields.Name,
            Contacts.Fields.FirstName,
            Contacts.Fields.LastName,
            Contacts.Fields.Emails,
            Contacts.Fields.PhoneNumbers,
          ])
        : selectedContact;

      const source = fullContact || selectedContact;
      const rawName = String(source.name || '').trim();
      const firstName = String(source.firstName || '').trim() || rawName;
      const lastName = String(source.lastName || '').trim();
      const email = String(source.emails?.[0]?.email || '').trim().toLowerCase();
      const mobileNumber = String(source.phoneNumbers?.[0]?.number || '').trim();

      if (!email && !mobileNumber) {
        setValidationMessage('That iPhone contact does not have an email or mobile number to share with.');
        return;
      }

      appendShareRecipients([{
        key: `contact:device:${source.id || Date.now()}`,
        label: `${firstName}${lastName ? ` ${lastName}` : ''}` || 'iPhone contact',
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        email: email || undefined,
        phone: mobileNumber ? formatPhoneNumberInput(mobileNumber) : undefined,
        source: 'contact',
      }]);
      setShareQuickAddPanel(null);
    } catch (error) {
      console.warn('Unable to pick an iPhone contact for sharing', error);
      setValidationMessage('Unable to open iPhone contacts right now.');
    }
  }, [appendShareRecipients]);

  const addManualEmailRecipient = useCallback(() => {
    const normalizedEmail = shareManualEmail.trim().toLowerCase();
    if (!validateEmail(normalizedEmail)) {
      setValidationMessage('Enter a valid email before adding it to the share list.');
      return;
    }

    appendShareRecipients([{
      key: `manual-email:${normalizedEmail}`,
      label: normalizedEmail,
      email: normalizedEmail,
      source: 'manual-email',
    }]);
    setShareManualEmail('');
  }, [appendShareRecipients, shareManualEmail]);

  const addManualPhoneRecipient = useCallback(() => {
    const formattedPhone = formatPhoneNumberInput(shareManualPhone);
    const phoneError = validatePhoneNumber(formattedPhone);
    if (phoneError) {
      setValidationMessage(phoneError);
      return;
    }

    appendShareRecipients([{
      key: `manual-phone:${formattedPhone.replace(/\D/g, '').slice(0, 10)}`,
      label: formattedPhone,
      phone: formattedPhone,
      source: 'manual-phone',
    }]);
    setShareManualPhone('');
  }, [appendShareRecipients, shareManualPhone]);

  useEffect(() => {
    let isActive = true;
    const query = form.eventLocationLine1.trim();

    if (!form.eventLocationEnabled || !isEventLocationLine1Focused || query.length < 4) {
      setEventLocationPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (skipNextEventLocationAutocompleteFetchRef.current > 0) {
      skipNextEventLocationAutocompleteFetchRef.current -= 1;
      setEventLocationPredictions([]);
      return () => {
        isActive = false;
      };
    }

    const timeoutId = setTimeout(() => {
      void findGoogleAddressPredictions(query, eventLocationAutocompleteSessionToken).then((predictions) => {
        if (isActive) {
          setEventLocationPredictions(predictions);
        }
      });
    }, 250);

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [eventLocationAutocompleteSessionToken, form.eventLocationEnabled, form.eventLocationLine1, isEventLocationLine1Focused]);

  const applyEventLocationPrediction = useCallback(async (prediction: GoogleAddressPrediction) => {
    skipNextEventLocationAutocompleteFetchRef.current = 2;
    setIsEventLocationLine1Focused(false);
    setEventLocationPredictions([]);

    setForm((current) => ({
      ...current,
      eventLocationLine1: prediction.mainText || prediction.description || '',
      eventLocationLine2: '',
      eventLocationFormattedAddress: prediction.description || prediction.mainText || '',
      eventLocationPlaceId: prediction.placeId,
    }));

    const resolved = await resolveGoogleAddressPrediction(prediction.placeId, eventLocationAutocompleteSessionToken);
    const nextLine1 = resolved?.line1 || prediction.mainText || prediction.description || '';

    setForm((current) => ({
      ...current,
      eventLocationLine1: nextLine1,
      eventLocationLine2: '',
      eventLocationFormattedAddress: resolved?.formattedAddress || prediction.description || prediction.mainText || '',
      eventLocationPlaceId: resolved?.placeId || prediction.placeId,
      eventLocationCity: resolved?.city || '',
      eventLocationState: normalizeStateCode(resolved?.state || ''),
      eventLocationZip: normalizeZipCode(resolved?.zip || ''),
    }));
  }, [eventLocationAutocompleteSessionToken]);

  const eventLocationNameSuggestions = (() => {
    const query = form.eventLocationName.trim().toLowerCase();
    if (!query || !isEventLocationNameFocused) {
      return [] as SavedEventLocation[];
    }

    return savedEventLocations
      .filter((entry) => entry.name.toLowerCase().includes(query))
      .slice(0, 6);
  })();

  const applySavedEventLocation = (location: SavedEventLocation) => {
    skipNextEventLocationAutocompleteFetchRef.current = 2;
    setIsEventLocationNameFocused(false);
    setIsEventLocationLine1Focused(false);
    setEventLocationPredictions([]);

    setForm((current) => ({
      ...current,
      eventLocationName: location.name,
      eventLocationPlaceId: location.placeId || '',
      eventLocationFormattedAddress: location.formattedAddress || '',
      eventLocationLine1: location.line1 || '',
      eventLocationLine2: location.line2 || '',
      eventLocationCity: location.city || '',
      eventLocationState: normalizeStateCode(location.state || ''),
      eventLocationZip: normalizeZipCode(location.zip || ''),
      eventLocationPhone: formatPhoneNumberInput(location.phone || ''),
    }));
  };

  const persistSavedEventLocation = async (location: EventLocationAddress) => {
    const normalizedName = (location.name || '').trim();
    if (!userId || !normalizedName) {
      return;
    }

    const withoutMatch = savedEventLocations.filter(
      (entry) => entry.name.trim().toLowerCase() !== normalizedName.toLowerCase(),
    );
    const nextEntry: SavedEventLocation = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: normalizedName,
      placeId: location.placeId,
      formattedAddress: location.formattedAddress,
      line1: location.line1 || undefined,
      line2: location.line2,
      city: location.city || undefined,
      state: location.state || undefined,
      zip: location.zip || undefined,
      phone: location.phone,
      updatedAt: new Date().toISOString(),
    };
    const next = [nextEntry, ...withoutMatch];
    setSavedEventLocations(next);

    try {
      await AsyncStorage.setItem(getEventLocationsStorageKey(userId), JSON.stringify(next));
    } catch (error) {
      console.warn('Unable to save event location', error);
    }
  };

  const restoreInterruptedModalContext = () => {
    if (!interruptedModalContext) {
      return;
    }

    setRemindersForEventId(interruptedModalContext.remindersForEventId);
    setSelectedEventPopupDate(interruptedModalContext.selectedEventPopupDate);
    setSelectedReminderPopup(interruptedModalContext.selectedReminderPopup);
    setSelectedReminderCalendarDate(interruptedModalContext.selectedReminderCalendarDate);
    setReminderPage(interruptedModalContext.reminderPage);
    setInterruptedModalContext(null);
  };

  useEffect(() => {
    (async () => {
      setHasLoadedInitialEvents(false);

      try {
        const stored = await loadEvents(userId);
        const repaired = repairLegacyReminderTimes(stored);
        setEvents(repaired.events);
        if (repaired.changed) {
          await saveEvents(repaired.events, userId);
        }
      } catch (error) {
        console.warn('Initial event load failed', error);
        setEvents([]);
      } finally {
        setHasLoadedInitialEvents(true);
      }

      try {
        const soundSettings = await loadReminderSoundSettings(userId);
        setReminderSoundEnabled(soundSettings.enabled);
      } catch (error) {
        console.warn('Reminder sound settings load failed', error);
      }

      try {
        const deliverySettings = await loadReminderDeliverySettings(userId);
        setReminderDeliveryDeviceEnabled(deliverySettings.device);
        setReminderDeliveryEmailEnabled(deliverySettings.email);
        setReminderDeliveryTextEnabled(deliverySettings.text);

        if (deliverySettings.device) {
          await requestNotificationPermission();
        }
      } catch (error) {
        console.warn('Reminder delivery settings load failed', error);
        setReminderDeliveryDeviceEnabled(true);
        setReminderDeliveryEmailEnabled(false);
        setReminderDeliveryTextEnabled(false);
      }

      try {
        const reminderTimeSettings = await loadReminderDefaultTimeSettings(userId);
        const clockIntervalMinutes = normalizeClockIntervalMinutes(reminderTimeSettings.clockIntervalMinutes);
        setDefaultReminderTime({
          hour: reminderTimeSettings.hour,
          minute: alignMinuteToClockInterval(reminderTimeSettings.minute, clockIntervalMinutes),
          clockIntervalMinutes,
        });
      } catch (error) {
        console.warn('Reminder default time settings load failed', error);
        setDefaultReminderTime({ hour: 9, minute: 0, clockIntervalMinutes: 5 });
      }

    })();
  }, [repairLegacyReminderTimes, userId]);

  useEffect(() => {
    if (!hasLoadedInitialEvents || !pendingBirthdayImports || !pendingBirthdayImports.length) {
      return;
    }

    if (isProcessingBirthdayImportsRef.current) {
      return;
    }
    isProcessingBirthdayImportsRef.current = true;

    (async () => {
      const createdEvents: SpecialDateEvent[] = [];
      let workingEvents = eventsRef.current;

      for (const entry of pendingBirthdayImports) {
        const contactName = String(entry.contactName || '').trim();
        const birthDateMatch = String(entry.birthDate || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!contactName || !birthDateMatch) {
          continue;
        }

        const [, monthStr, dayStr, yearStr] = birthDateMatch;
        const birthDate = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
        if (Number.isNaN(birthDate.getTime())) {
          continue;
        }
        birthDate.setHours(0, 0, 0, 0);

        const eventDateValue = getNextAnnualOccurrenceDate(birthDate, true);

        const duplicateCandidate = {
          title: 'Birthday',
          people: contactName,
          eventDateTime: eventDateValue,
          eventAllDay: true,
        };
        const isDuplicate = workingEvents.some((event) => isTrueDuplicateEvent(event, duplicateCandidate))
          || createdEvents.some((event) => isTrueDuplicateEvent(event, duplicateCandidate));

        if (isDuplicate) {
          continue;
        }

        const reminderAnchorDate = getDefaultReminderAnchorDate(eventDateValue, true, true);
        const defaultReminderDrafts = buildDefaultReminderDrafts(
          reminderAnchorDate,
          '',
          contactName,
          'Birthday',
          defaultReminderTime,
        );

        const variableReminderEntries: VariableReminderEntry[] = defaultReminderDrafts.map((item) => ({
          id: item.id,
          reminderDateTime: item.reminderDateTime,
          notes: '',
        }));

        const primaryReminderDateTime = variableReminderEntries[0]?.reminderDateTime
          || convertWallDateInTimeZoneToUtcIso(eventDateValue, effectiveReminderTimeZone);

        const newEvent: SpecialDateEvent = {
          id: createEventId(),
          title: 'Birthday',
          people: contactName,
          ageAsOfToday: eventDateValue.getFullYear() - Number(yearStr),
          eventDateTime: eventDateValue.toISOString(),
          reminderDateTime: primaryReminderDateTime,
          eventAllDay: true,
          reminderAllDay: true,
          reminderTimeZone: effectiveReminderTimeZone,
          frequency: 'yearly',
          reminderMode: 'default',
          notified: false,
          ...(variableReminderEntries.length ? { variableReminders: variableReminderEntries } : {}),
        };

        createdEvents.push(newEvent);
        workingEvents = [newEvent, ...workingEvents];

        await scheduleEventDeviceReminders('Birthday', contactName, 'default', primaryReminderDateTime, variableReminderEntries);
      }

      if (createdEvents.length) {
        const updated = [...createdEvents, ...eventsRef.current];
        setEvents(updated);
        await saveEvents(updated, userId);
        const reloaded = await loadEvents(userId);
        setEvents(reloaded);
        void autoPushGoogleCalendarIfConfigured();
      }

      isProcessingBirthdayImportsRef.current = false;
      onBirthdayImportsProcessed?.();
    })();
  }, [hasLoadedInitialEvents, pendingBirthdayImports, userId, defaultReminderTime, effectiveReminderTimeZone, onBirthdayImportsProcessed]);

  useEffect(() => {
    const unsubscribe = subscribeApiStorageStatus((message) => {
      setApiStorageStatusMessage(message);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (remindersForEventId) {
      setReminderPage(0);
    }
  }, [remindersForEventId]);

  useEffect(() => {
    latestModalContextRef.current = {
      remindersForEventId,
      selectedEventPopupDate,
      selectedReminderPopup,
      selectedReminderCalendarDate,
      reminderPage,
    };
  }, [remindersForEventId, selectedEventPopupDate, selectedReminderPopup, selectedReminderCalendarDate, reminderPage]);

  const refreshSavedData = useCallback(async (options?: { silent?: boolean }) => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    setIsRefreshingSavedData(true);
    try {
      const reloaded = await loadEvents(userId);
      const repaired = repairLegacyReminderTimes(reloaded);
      setEvents(repaired.events);
      if (repaired.changed) {
        await saveEvents(repaired.events, userId);
      }
      if (!options?.silent) {
        setValidationMessage(null);
      }
    } catch (error) {
      console.warn('Saved data refresh failed', error);
      if (!options?.silent) {
        setValidationMessage('Unable to refresh saved events and reminders right now.');
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshingSavedData(false);
    }
  }, [repairLegacyReminderTimes, userId]);

  const refreshPendingShareInvites = useCallback(async () => {
    if (!userId) {
      setPendingShareInvites([]);
      setActiveShareInvite(null);
      return;
    }

    try {
      const invites = await loadPendingShareInvites(userId);
      setPendingShareInvites(invites);
      setActiveShareInvite((current) => {
        if (!invites.length) {
          return null;
        }

        if (current) {
          const refreshed = invites.find((invite) => invite.id === current.id);
          if (refreshed) {
            return refreshed;
          }
        }

        return invites[0];
      });
    } catch (error) {
      console.warn('Pending share invite refresh failed', error);
      // Keep the current invite state during transient API outages.
    }
  }, [userId]);

  useEffect(() => {
    void refreshPendingShareInvites();

    const intervalId = setInterval(() => {
      void refreshPendingShareInvites();
    }, 5000);

    return () => clearInterval(intervalId);
  }, [refreshPendingShareInvites]);

  useEffect(() => {
    if (currentView !== 'create-reminders' || hasInitializedReminderScheduleView || !isReminderTimeZoneMode(form.reminderMode)) {
      return;
    }

    const now = getDefaultDate();
    setPickerMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setPendingReminderDateTime(new Date(now));
    setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setForm((current) => ({
      ...current,
      reminderDateTime: new Date(now),
    }));
    setHasInitializedReminderScheduleView(true);
  }, [currentView, hasInitializedReminderScheduleView, form.reminderMode]);

  useEffect(() => {
    if (currentView !== 'create-reminders' || form.reminderMode !== 'default') {
      return;
    }

    const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);
    const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
    const defaultReminderEventDate = getDefaultReminderAnchorDate(form.eventDateTime, isAnnualEvent, isAllDay);

    const defaultReminders = buildDefaultReminderDrafts(
      defaultReminderEventDate,
      form.notes.trim(),
      form.people.trim(),
      getEventTitle(form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype),
      defaultReminderTime,
    );
    setPendingVariableReminders(defaultReminders);
    setSeededVariableDraftIds(defaultReminders.map((item) => item.id));
  }, [currentView, form.reminderMode, form.eventDateTime, form.notes, form.people, form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype, defaultReminderTime]);

  useEffect(() => {
    if (currentView !== 'create-reminders' || form.reminderMode !== 'static' || hasTouchedStaticReminderSchedule) {
      return;
    }

    const now = getDefaultDate();
    setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setForm((current) => ({
      ...current,
      reminderDateTime: new Date(now),
    }));
  }, [currentView, form.reminderMode, hasTouchedStaticReminderSchedule]);

  useEffect(() => {
    if (!events.length) return;

    const checkReminders = async () => {
      const now = new Date();
      const activeEvents = events.filter((event) => !shouldRemovePastEvent(event, now));
      if (activeEvents.length !== events.length) {
        setEvents(activeEvents);
        await saveEvents(activeEvents, userId);
        return;
      }

      const reminderCandidates = activeEvents.flatMap((event) => getReminderCandidates(event));
      const dueReminder = reminderCandidates.find((candidate) => {
        if (candidate.entry) {
          return new Date(candidate.reminderDateTime).getTime() <= now.getTime();
        }

        return shouldTriggerReminder(candidate.event, now);
      });

      if (dueReminder) {
        const updatedEvents = events.map((event) => {
          if (event.id !== dueReminder.event.id) {
            return event;
          }

          if (isBirthdayOrAnniversaryEvent(event)) {
            // Always use UTC-component-aware local date so UTC-midnight storage in
            // negative-offset timezones doesn't shift the calendar day backward.
            const eventDate = getLocalDateFromUtcDay(event.eventDateTime);
            // For static yearly triggers, dueReminder.reminderDateTime is the
            // original stored time (possibly from a prior year), so compare against
            // `now` instead. For variable entries, compare the entry's specific time.
            const comparisonDate = dueReminder.entry
              ? new Date(dueReminder.reminderDateTime)
              : now;
            if (isSameCalendarDay(comparisonDate, eventDate)) {
              return buildNextYearBirthdayOrAnniversaryEvent(event, defaultReminderTime);
            }
          }

          if (dueReminder.entry) {
            return {
              ...event,
              variableReminders: (event.variableReminders || [])
                .filter((entry) => entry.id !== dueReminder.entryId),
            };
          }

          return {
            ...event,
            lastReminderTriggeredAt: now.toISOString(),
            notified: true,
          };
        });

        setEvents(updatedEvents);
        try {
          await saveEvents(updatedEvents, userId);
        } catch (error) {
          console.warn('Unable to persist reminder trigger state before delivery.', error);
          setApiStorageStatusMessage('Reminder delivery triggered, but saving reminder state failed. It may retry after refresh.');
        }

        if (!apiStorageEnabled && reminderDeliveryTextEnabled) {
          void sendReminderSmsNotification(userId, {
            eventId: dueReminder.event.id,
            eventTitle: dueReminder.event.title,
            people: dueReminder.event.people,
            eventDateTime: dueReminder.event.eventDateTime,
            eventAllDay: dueReminder.event.eventAllDay,
            reminderTimeZone: dueReminder.event.reminderTimeZone,
            notes: dueReminder.entry?.notes || dueReminder.event.notes,
          });
        }

        if (!apiStorageEnabled && reminderDeliveryEmailEnabled) {
          void sendReminderEmailNotification(userId, {
            eventId: dueReminder.event.id,
            eventTitle: dueReminder.event.title,
            people: dueReminder.event.people,
            eventDateTime: dueReminder.event.eventDateTime,
            eventAllDay: dueReminder.event.eventAllDay,
            reminderDateTime: dueReminder.reminderDateTime,
            reminderTimeZone: dueReminder.event.reminderTimeZone,
            notes: dueReminder.entry?.notes || dueReminder.event.notes,
          });
        }

        if (!reminderDeliveryDeviceEnabled) {
          return;
        }

        // Reminder alerts take precedence over any currently open detail/list modal.
        const currentModalContext = latestModalContextRef.current;
        const shouldCaptureContext = currentModalContext.remindersForEventId !== null
          || currentModalContext.selectedEventPopupDate !== null
          || currentModalContext.selectedReminderPopup !== null;
        if (shouldCaptureContext) {
          setInterruptedModalContext((current) => current ?? {
            remindersForEventId: currentModalContext.remindersForEventId,
            selectedEventPopupDate: currentModalContext.selectedEventPopupDate,
            selectedReminderPopup: currentModalContext.selectedReminderPopup,
            selectedReminderCalendarDate: currentModalContext.selectedReminderCalendarDate,
            reminderPage: currentModalContext.reminderPage,
          });
        }

        setRemindersForEventId(null);
        setSelectedEventPopupDate(null);
        setSelectedReminderPopup(null);
        setConfirmCancelEventId(null);
        setConfirmDeleteReminder(null);

        if (reminderSoundEnabled) {
          void playReminderPing({
            pattern: 'double',
            volume: 'loud',
          });
        }

        setActiveReminder({
          ...dueReminder.event,
          reminderDateTime: dueReminder.reminderDateTime,
          notified: true,
        });
      }
    };

    checkReminders();
    const interval = setInterval(checkReminders, 1000);
    return () => clearInterval(interval);
  }, [
    defaultReminderTime,
    events,
    reminderDeliveryDeviceEnabled,
    reminderDeliveryEmailEnabled,
    reminderDeliveryTextEnabled,
    reminderSoundEnabled,
    userId,
  ]);

  const dedupeVariableReminderDrafts = (items: SpecialDateEvent[]) => {
    const byTime = new Map<number, SpecialDateEvent>();
    items.forEach((item) => {
      const reminderTime = new Date(item.reminderDateTime).getTime();
      if (!byTime.has(reminderTime)) {
        byTime.set(reminderTime, item);
      }
    });
    return [...byTime.values()];
  };

  const sortVariableReminderDrafts = (items: SpecialDateEvent[]) => (
    dedupeVariableReminderDrafts([...items]).sort((left, right) => new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime())
  );

  const filterFutureReminderDrafts = (items: SpecialDateEvent[]) => (
    items.filter((item) => new Date(item.reminderDateTime).getTime() >= Date.now())
  );

  const addPendingVariableReminder = () => {
    if (form.reminderMode === 'static') {
      if (!isStaticReminderTimeSelected) {
        setValidationMessage('Please choose a reminder time before adding reminders.');
        return;
      }

      const staticOccurrences = getStaticReminderOccurrencesForForm();
      if (!staticOccurrences.length) {
        setValidationMessage('No upcoming recurring reminders found for this schedule.');
        return;
      }

      const seededDrafts = sortVariableReminderDrafts(convertOccurrencesToPendingReminders(staticOccurrences));
      setPendingVariableReminders((current) => sortVariableReminderDrafts([
        ...current,
        ...seededDrafts,
      ]));
      setSeededVariableDraftIds((current) => {
        const merged = new Set([...current, ...seededDrafts.map((item) => item.id)]);
        return [...merged];
      });
      setValidationMessage(null);
      setIsReminderAddedFlash(true);
      setIsStaticReminderTimeSelected(false);
      setForm((current) => ({
        ...current,
        reminderDateTime: new Date(0),
      }));
      setTimeout(() => {
        setIsReminderAddedFlash(false);
      }, 500);
      return;
    }

    if (!isVariableReminderTimeSelected) {
      setValidationMessage('Please choose a reminder time before adding reminders.');
      return;
    }

    const sourceReminderDate = pendingReminderDateTime;
    const nextReminderDate = new Date(sourceReminderDate);
    nextReminderDate.setHours(sourceReminderDate.getHours(), sourceReminderDate.getMinutes(), 0, 0);
    const storedReminderDateTime = convertWallDateInTimeZoneToUtcIso(nextReminderDate, form.reminderTimeZone);
    const storedReminderTime = new Date(storedReminderDateTime).getTime();

    if (storedReminderTime < Date.now()) {
      setValidationMessage('Please choose a reminder time that is in the future.');
      return;
    }

    const isAllDayForReminderCheck = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
    const eventDateForReminderCheck = new Date(form.eventDateTime);
    if (isAllDayForReminderCheck) {
      eventDateForReminderCheck.setHours(0, 0, 0, 0);
    }

    if (!isReminderTimeWithinEventWindow(nextReminderDate, eventDateForReminderCheck, isAllDayForReminderCheck)) {
      setValidationMessage(isAllDayForReminderCheck
        ? 'Reminder time cannot be after the day of the event.'
        : 'Reminder time cannot be after the event start time.');
      return;
    }

    const isDuplicatePending = pendingVariableReminders.some((item) => new Date(item.reminderDateTime).getTime() === storedReminderTime);

    if (isDuplicatePending) {
      setValidationMessage('Duplicate reminder ignored.');
      return;
    }

    setValidationMessage(null);

    const nextReminder: SpecialDateEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${pendingVariableReminders.length}`,
      title: 'Custom reminder',
      people: form.people.trim() || 'You',
      eventDateTime: form.eventDateTime.toISOString(),
      reminderDateTime: storedReminderDateTime,
      eventAllDay: form.eventAllDay,
      reminderAllDay: form.reminderAllDay,
      frequency: 'once',
      notes: form.notes.trim(),
      notified: false,
    };

    setPendingVariableReminders((current) => sortVariableReminderDrafts([...current, nextReminder]));
    setIsReminderAddedFlash(true);
    setIsVariableReminderTimeSelected(false);
    setPendingReminderDateTime(new Date(0));
    setTimeout(() => {
      setIsReminderAddedFlash(false);
    }, 500);
  };

  const addReminderToEvent = async (eventId: string) => {
    const selectedEvent = events.find((event) => event.id === eventId);
    if (!selectedEvent) return;

    const now = new Date();
    const nextReminderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0);
    const reminderEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${selectedEvent.id}`,
      reminderDateTime: nextReminderDate.toISOString(),
      notes: '',
    };

    const updatedEvents = events.map((event) => {
      if (event.id !== eventId) {
        return event;
      }

      const reminderMode = getReminderModeValue(event);
      const nextVariableReminderEntries: VariableReminderEntry[] = [
        ...(event.variableReminders || []),
        {
          id: reminderEntry.id,
          reminderDateTime: reminderEntry.reminderDateTime,
          notes: event.notes || '',
        },
      ].sort((left, right) => new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime());

      const nextReminderDateTime = reminderMode === 'static'
        ? event.reminderDateTime
        : nextVariableReminderEntries[0]?.reminderDateTime || event.reminderDateTime;

      return {
        ...event,
        frequency: reminderMode === 'none' ? 'once' : event.frequency,
        reminderMode: reminderMode === 'none' ? 'variable' : reminderMode,
        reminderDateTime: nextReminderDateTime,
        variableReminders: nextVariableReminderEntries,
      };
    });

    setEvents(updatedEvents);
    await saveEvents(updatedEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
  };

  const removePendingVariableReminder = (id: string) => {
    setPendingVariableReminders((current) => current.filter((item) => item.id !== id));
    setSeededVariableDraftIds((current) => current.filter((seededId) => seededId !== id));
  };

  const scheduleEventDeviceReminders = async (
    title: string,
    people: string,
    reminderMode: ReminderModeValue,
    primaryReminderDateTime: string,
    entries: VariableReminderEntry[],
  ) => {
    if (reminderMode === 'none') {
      return;
    }

    const futureReminderDates = (entries.length
      ? entries.map((entry) => new Date(entry.reminderDateTime))
      : [new Date(primaryReminderDateTime)]
    )
      .filter((date) => Number.isFinite(date.getTime()) && date.getTime() > Date.now())
      .sort((left, right) => left.getTime() - right.getTime())
      .filter((date, index, all) => index === 0 || date.getTime() !== all[index - 1].getTime());

    if (!futureReminderDates.length) {
      return;
    }

    const schedulingResults = await Promise.allSettled(futureReminderDates.map((date) => scheduleReminder(
      'Calendar Reminder',
      `${title} for ${people}`,
      date,
    )));

    const failedSchedules = schedulingResults.filter((result) => (
      result.status === 'rejected' || (result.status === 'fulfilled' && !result.value)
    ));

    if (failedSchedules.length) {
      console.warn('Some reminder schedules failed', failedSchedules);
      setApiStorageStatusMessage('Reminder saved, but one or more device reminders failed to schedule. Verify notification permission in iOS Settings for Remind Me This.');
    }
  };

  const getFutureDeviceReminderDatesForEvent = (event: SpecialDateEvent, now: Date) => {
    const reminderMode = getReminderModeValue(event);
    if (reminderMode === 'none') {
      return [] as Date[];
    }

    const variableFutureDates = (event.variableReminders || [])
      .map((entry) => new Date(entry.reminderDateTime))
      .filter((date) => Number.isFinite(date.getTime()) && date.getTime() > now.getTime());

    if (variableFutureDates.length) {
      return variableFutureDates;
    }

    const nextOccurrence = getNextReminderOccurrenceForEvent(event, now);
    if (!Number.isFinite(nextOccurrence.getTime()) || nextOccurrence.getTime() <= now.getTime()) {
      return [] as Date[];
    }

    return [nextOccurrence];
  };

  useEffect(() => {
    let cancelled = false;

    const syncScheduledDeviceReminders = async () => {
      if (!hasLoadedInitialEvents) {
        return;
      }

      if (!reminderDeliveryDeviceEnabled) {
        await clearScheduledReminders();
        return;
      }

      const now = new Date();
      const scheduleQueue: Array<{ title: string; people: string; date: Date }> = [];

      events.forEach((event) => {
        const dates = getFutureDeviceReminderDatesForEvent(event, now);
        dates.forEach((date) => {
          scheduleQueue.push({
            title: event.title,
            people: event.people,
            date,
          });
        });
      });

      const dedupedQueue = [...new Map(
        scheduleQueue.map((item) => [`${item.title}|${item.people}|${item.date.getTime()}`, item]),
      ).values()].sort((left, right) => left.date.getTime() - right.date.getTime());

      const prioritizedQueue = Platform.OS === 'ios'
        ? dedupedQueue.slice(0, IOS_SCHEDULE_LIMIT)
        : dedupedQueue;

      await clearScheduledReminders();

      if (!prioritizedQueue.length || cancelled) {
        return;
      }

      if (Platform.OS === 'ios' && dedupedQueue.length > prioritizedQueue.length) {
        // Suppress the iOS queue-limit banner in the UI while still honoring the queue cap.
        if (SHOW_NOTIFICATION_DIAGNOSTICS) {
          console.log('iOS reminder queue capped at 64 notifications; scheduled the next soonest reminders only.');
        }
      }

      const schedulingResults = await Promise.allSettled(prioritizedQueue.map((item) => scheduleReminder(
        'Calendar Reminder',
        `${item.title} for ${item.people}`,
        item.date,
      )));

      if (cancelled) {
        return;
      }

      const failedSchedules = schedulingResults.filter((result) => (
        result.status === 'rejected' || (result.status === 'fulfilled' && !result.value)
      ));

      if (failedSchedules.length) {
        setApiStorageStatusMessage('Some device reminders could not be scheduled. Check iOS Notifications settings for Remind Me This.');
      }

      if (SHOW_NOTIFICATION_DIAGNOSTICS) {
        const diagnostics = await getNotificationDiagnostics();
        console.log('notification diagnostics (post-sync)', diagnostics);
      }
    };

    void syncScheduledDeviceReminders();

    return () => {
      cancelled = true;
    };
  }, [events, hasLoadedInitialEvents, reminderDeliveryDeviceEnabled]);

  const saveCurrentEvent = async () => {
    if (isSavingEvent) {
      return;
    }

    setIsSavingEvent(true);
    try {
      if (!hasSelectedEventType) {
        setValidationMessage('Please choose an event type.');
        return;
      }

      if (eventTypeHasSubtype(form.eventType) && !hasSelectedSubtype) {
        setValidationMessage(`Please choose a ${String(getSubtypeFieldLabel(form.eventType) || 'subtype').toLowerCase()}.`);
        return;
      }

      if (form.eventType === 'other' && !form.customType.trim()) {
        Alert.alert('Missing info', 'Please enter a custom event type.');
        return;
      }

      if (!form.people.trim()) {
        setValidationMessage('Please enter a person, people, group, place, or description.');
        return;
      }

      const ageValue = form.ageAsOfToday.trim();
      const parsedBirthdayAge = ageValue ? Number.parseInt(ageValue, 10) : getAgeAsOfToday(form.eventDateTime);
      if (form.eventType === 'birthday' && parsedBirthdayAge !== null && (!Number.isFinite(parsedBirthdayAge) || parsedBirthdayAge < 0)) {
        setValidationMessage('Please enter a valid age for birthday events.');
        return;
      }

      const selectedReminderDateTime = convertWallDateInTimeZoneToUtcIso(form.reminderDateTime, form.reminderTimeZone);

      const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);

      if (form.reminderMode === 'static' && !isAnnualEvent && new Date(selectedReminderDateTime).getTime() < Date.now()) {
        setValidationMessage('Please choose a reminder time that is in the future.');
        return;
      }

      if (form.reminderMode === 'static' && !pendingVariableReminders.length) {
        setValidationMessage('Press Add Reminder(s) to load recurring reminders into the queue before saving.');
        return;
      }

      if (isNoReminderMode(form.reminderMode)) {
        setValidationMessage(null);
      }

      setValidationMessage(null);

      const peopleLabel = form.people.trim();
      const notes = form.notes.trim();
      const eventLocation = buildEventLocationFromForm(form);
      if (form.eventLocationSaveEnabled && eventLocation?.name) {
        void persistSavedEventLocation(eventLocation);
      }
      const resolvedEventType = getEventTitle(form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype);
      const reminderFrequency = (form.reminderMode === 'variable' || form.reminderMode === 'default')
        ? 'once' as ReminderFrequency
        : form.frequency;
      const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
      const canUseEventEndTime = supportsEventEndTime(form.eventType, form.partySubtype, form.eventAllDay);
      const eventDateValue = isAnnualEventType(form.eventType, form.partySubtype)
        ? getNextAnnualOccurrenceDate(new Date(form.eventDateTime), isAllDay)
        : new Date(form.eventDateTime);
      const eventEndDateValue = resolveEventEndDateTime(eventDateValue, form.eventEndDateTime);
      const reminderDateValue = new Date(form.reminderDateTime);
      if (isAllDay) {
        eventDateValue.setHours(0, 0, 0, 0);
      }

      if (canUseEventEndTime) {
        eventEndDateValue.setFullYear(
          eventDateValue.getFullYear(),
          eventDateValue.getMonth(),
          eventDateValue.getDate(),
        );

        if (eventEndDateValue.getTime() < eventDateValue.getTime()) {
          setValidationMessage('Event End time cannot be before Event Start time.');
          return;
        }
      }

      if (form.reminderAllDay) {
        reminderDateValue.setHours(0, 0, 0, 0);
      }
      const reminderDateTimeInUtc = convertWallDateInTimeZoneToUtcIso(reminderDateValue, form.reminderTimeZone);

      if (form.reminderMode === 'variable' && pendingVariableReminders.some((item) => (
        !isReminderTimeWithinEventWindow(new Date(item.reminderDateTime), eventDateValue, isAllDay)
      ))) {
        setValidationMessage(isAllDay
          ? 'One or more reminders are set after the day of the event.'
          : 'One or more reminders are set after the event start time.');
        return;
      }

      const duplicateEvent = events.find((event) => isTrueDuplicateEvent(event, {
        title: resolvedEventType,
        people: peopleLabel,
        eventDateTime: eventDateValue,
        eventAllDay: isAllDay,
      }));

      if (duplicateEvent) {
        const duplicateMessage = getDuplicateEventValidationMessage();
        setValidationMessage(duplicateMessage);
        Alert.alert('Duplicate event', duplicateMessage);
        return;
      }

      const effectivePendingVariableReminders: SpecialDateEvent[] = form.reminderMode === 'default' && !pendingVariableReminders.length
        ? buildDefaultReminderDrafts(
            getDefaultReminderAnchorDate(eventDateValue, isAnnualEvent, isAllDay),
            notes,
            peopleLabel,
            resolvedEventType,
            defaultReminderTime,
          )
        : pendingVariableReminders;

      const queuedReminderEntries: VariableReminderEntry[] = effectivePendingVariableReminders.map((item) => ({
        id: item.id,
        reminderDateTime: form.reminderMode === 'static'
          ? convertWallDateInTimeZoneToUtcIso(new Date(item.reminderDateTime), form.reminderTimeZone)
          : item.reminderDateTime,
        notes,
      }));

      const variableReminderEntries: VariableReminderEntry[] = isNoReminderMode(form.reminderMode)
        ? []
        : form.reminderMode === 'static'
          ? queuedReminderEntries
          : queuedReminderEntries;

      const primaryReminderDateTime = form.reminderMode === 'static' || form.reminderMode === 'default'
        ? variableReminderEntries[0]?.reminderDateTime || reminderDateTimeInUtc
        : variableReminderEntries.length
        ? variableReminderEntries.reduce((earliest, entry) => (
            new Date(entry.reminderDateTime).getTime() < new Date(earliest.reminderDateTime).getTime() ? entry : earliest
          ), variableReminderEntries[0]).reminderDateTime
        : reminderDateTimeInUtc;

      const newEvent: SpecialDateEvent = {
        id: createEventId(),
        title: resolvedEventType,
        people: peopleLabel,
        ageAsOfToday: form.eventType === 'birthday' && parsedBirthdayAge !== null ? parsedBirthdayAge : undefined,
        eventDateTime: eventDateValue.toISOString(),
        ...(canUseEventEndTime ? { eventEndDateTime: eventEndDateValue.toISOString() } : {}),
        reminderDateTime: primaryReminderDateTime,
        eventAllDay: isAllDay,
        reminderAllDay: form.reminderAllDay,
        reminderTimeZone: effectiveReminderTimeZone,
        frequency: reminderFrequency,
        reminderMode: isNoReminderMode(form.reminderMode) ? 'none' : form.reminderMode,
        notes,
        eventLocation,
        notified: false,
        ...(variableReminderEntries.length ? { variableReminders: variableReminderEntries } : {}),
      };

      const updated = [newEvent, ...events];
      setEvents(updated);

      const wantsShare = form.shareAfterSave;
      const wantsRsvp = form.shareWithRsvp;

      setEditingEvent(null);
      resetTypeSelectionUi();
      setPendingVariableReminders([]);
      setSeededVariableDraftIds([]);
      setHasTouchedStaticReminderSchedule(false);
      const resetDate = new Date();
      resetDate.setSeconds(0);
      setForm(getResetFormState(effectiveReminderTimeZone));
      setPickerMonth(new Date(resetDate));
      setStaticReminderMonth(new Date(resetDate.getFullYear(), resetDate.getMonth(), 1));
      setPendingReminderDateTime(new Date(resetDate));
      setPendingReminderMonth(new Date(resetDate.getFullYear(), resetDate.getMonth(), 1));
      setViewVersion((value) => value + 1);

      await saveEvents(updated, userId);
      const reloaded = await loadEvents(userId);
      setEvents(reloaded);
      void autoPushGoogleCalendarIfConfigured();

      await scheduleEventDeviceReminders(
        newEvent.title,
        newEvent.people,
        newEvent.reminderMode || 'none',
        primaryReminderDateTime,
        variableReminderEntries,
      );

      proceedAfterEventSave(newEvent, wantsShare, wantsRsvp);
    } catch (error) {
      console.error('saveCurrentEvent failed', error);
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsSavingEvent(false);
    }
  };

  const dismissReminder = async (eventId: string) => {
    const updated = events.map((event) => (event.id === eventId ? { ...event, notified: true } : event));
    setEvents(updated);
    await saveEvents(updated, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setActiveReminder(null);
    restoreInterruptedModalContext();
  };

  const formatActiveReminderWhen = (event: SpecialDateEvent) => {
    const eventDate = new Date(event.eventDateTime);
    if (isAllDaySpecialDateEvent(event)) {
      return `On ${eventDate.toLocaleDateString()}`;
    }

    const timeLabel = eventDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dateLabel = eventDate.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return `@ ${timeLabel} (${dateLabel})`;
  };

  const handleViewActiveReminder = () => {
    if (!activeReminderEntry) {
      setActiveReminder(null);
      restoreInterruptedModalContext();
      return;
    }

    setActiveReminder(null);
    setInterruptedModalContext(null);
    setRemindersForEventId(null);
    setSelectedEventPopupDate(null);
    setSelectedReminderPopup(null);
    setSelectedReminderCalendarDate(null);
    setCurrentView('manage-events');
    setSelectedSummaryEventId(activeReminderEntry.event.id);
  };

  const deleteReminderEntry = async (eventId: string, reminderEntryId: string) => {
    const currentEvents = events;
    const targetEvent = currentEvents.find((event) => event.id === eventId);

    if (!targetEvent) {
      setConfirmDeleteReminder(null);
      setRemindersForEventId(null);
      setSelectedSummaryEventId(null);
      return;
    }

    const nextEvents = currentEvents.map((event): SpecialDateEvent => {
      if (event.id !== eventId) {
        return event;
      }

      const nextVariableReminders = (event.variableReminders || []).filter((entry) => entry.id !== reminderEntryId);
      const reminderMode = getReminderModeValue(event);

      if (!nextVariableReminders.length) {
        return {
          ...event,
          reminderMode: 'none',
          variableReminders: undefined,
          notified: false,
          lastReminderTriggeredAt: undefined,
        };
      }

      const nextReminderDateTime = nextVariableReminders.reduce((earliest, entry) => (
        new Date(entry.reminderDateTime).getTime() < new Date(earliest.reminderDateTime).getTime() ? entry : earliest
      ), nextVariableReminders[0]).reminderDateTime;

      return {
        ...event,
        reminderMode: reminderMode === 'static' ? 'variable' : 'variable',
        variableReminders: nextVariableReminders,
        reminderDateTime: nextReminderDateTime,
        notified: false,
        lastReminderTriggeredAt: undefined,
      };
    });

    setEvents(nextEvents);
    await saveEvents(nextEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setConfirmDeleteReminder(null);
    setRemindersForEventId(null);
    setSelectedSummaryEventId(null);
    Alert.alert('Removed', 'The reminder has been removed.');
  };

  const deleteStaticReminder = async (eventId: string) => {
    const updatedEvents = events.map((event) => {
      if (event.id !== eventId) {
        return event;
      }

      const nextVariableReminders = (event.variableReminders || [])
        .filter((entry) => new Date(entry.reminderDateTime).getTime() >= Date.now())
        .sort((left, right) => new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime());

      if (nextVariableReminders.length) {
        return {
          ...event,
          frequency: 'once' as ReminderFrequency,
          reminderMode: 'variable' as ReminderModeValue,
          reminderDateTime: nextVariableReminders[0].reminderDateTime,
          variableReminders: nextVariableReminders,
          notified: false,
        };
      }

      return {
        ...event,
        reminderMode: 'none' as ReminderModeValue,
        variableReminders: undefined,
        notified: false,
      };
    });

    setEvents(updatedEvents);
    await saveEvents(updatedEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setConfirmDeleteReminder(null);
    Alert.alert('Removed', 'The recurring reminder has been removed.');
  };

  const deleteReminderEvent = async (eventId: string) => {
    const eventToDelete = events.find((event) => event.id === eventId);
    const updated = events.filter((event) => event.id !== eventId);
    setEvents(updated);
    await saveEvents(updated, userId);
    // Deleting the Event row cascades (at the database level) to its EventReminders and, if
    // it had RSVPs enabled, its RsvpInvite/RsvpResponse rows too — nothing further to clean up
    // server-side, just the ephemeral client-side cache/state referencing this event. The
    // event's contacts group (if any) is intentionally left alone here — see the Keep/Rename/
    // Delete prompt below, since deleting it silently isn't wanted.
    setRsvpSummaries((current) => {
      if (!(eventId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[eventId];
      return next;
    });
    if (rsvpManagerEventId === eventId) {
      setRsvpManagerEventId(null);
    }
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setActiveReminder(null);
    setConfirmDeleteReminder(null);

    const associatedGroup = eventToDelete?.rsvpEnabled ? await findRsvpGroupForEvent(eventToDelete) : null;
    Alert.alert('Removed', 'The event and all associated reminders and RSVP data have been removed.', [
      {
        text: 'OK',
        onPress: () => {
          if (associatedGroup) {
            setPendingRsvpGroupPrompt({ groupId: associatedGroup.id, groupName: associatedGroup.name });
          }
        },
      },
    ]);
  };

  const deleteAllRemindersForEvent = async (eventId: string) => {
    const updatedEvents = events.map((event) => {
      if (event.id !== eventId) {
        return event;
      }

      return {
        ...event,
        reminderMode: 'none' as ReminderModeValue,
        variableReminders: undefined,
        notified: false,
        lastReminderTriggeredAt: undefined,
      };
    });

    setEvents(updatedEvents);
    await saveEvents(updatedEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setRemindersForEventId(null);
    setConfirmDeleteReminder(null);
    setSelectedSummaryEventId(null);
    Alert.alert('Removed', 'All reminders for this event have been removed.');
  };

  const promptReminderDelete = (eventId: string, reminderEntryId?: string, reminderSource?: 'static' | 'variable', target: 'reminder' | 'all-reminders' = 'reminder') => {
    const performDelete = async () => {
      if (target === 'all-reminders') {
        await deleteAllRemindersForEvent(eventId);
        return;
      }

      if (reminderEntryId) {
        await deleteReminderEntry(eventId, reminderEntryId);
        return;
      }

      if (reminderSource === 'static') {
        await deleteStaticReminder(eventId);
        return;
      }

      await deleteAllRemindersForEvent(eventId);
    };

    Alert.alert(
      target === 'all-reminders' ? 'Delete all reminders?' : 'Delete reminder?',
      'This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void performDelete();
          },
        },
      ],
    );
  };

  const promptEventDelete = (eventId: string) => {
    Alert.alert(
      'Delete event?',
      'This will remove the event and all associated reminders.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteReminderEvent(eventId);
          },
        },
      ],
    );
  };

  const cancelEvent = async (eventId: string) => {
    const eventToCancel = events.find((event) => event.id === eventId);
    const updated = events.filter((event) => event.id !== eventId);
    setEvents(updated);
    await saveEvents(updated, userId);
    setRsvpSummaries((current) => {
      if (!(eventId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[eventId];
      return next;
    });
    if (rsvpManagerEventId === eventId) {
      setRsvpManagerEventId(null);
    }
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setConfirmCancelEventId(null);

    const associatedGroup = eventToCancel?.rsvpEnabled ? await findRsvpGroupForEvent(eventToCancel) : null;
    Alert.alert('Deleted', 'The event and all associated reminders and RSVP data have been removed.', [
      {
        text: 'OK',
        onPress: () => {
          if (associatedGroup) {
            setPendingRsvpGroupPrompt({ groupId: associatedGroup.id, groupName: associatedGroup.name });
          }
        },
      },
    ]);
  };

  const formatEventSummary = (event: SpecialDateEvent) => {
    const eventDateLabel = formatEventDateOnly(event);
    if (isAllDaySpecialDateEvent(event)) {
      return `Event: ${eventDateLabel} • All-day`;
    }

    return `Event: ${eventDateLabel} • ${formatEventTimeOnlyLabel(event)}`;
  };

  const formatDateOnlyLabel = (date: Date) => (
    date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  );

  const formatCountdownLabelForDate = (date: Date) => {
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const diffDays = Math.round((startOfDay.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000));

    if (diffDays === 0) {
      return 'Today';
    }
    if (diffDays === 1) {
      return '1 day';
    }
    if (diffDays > 1) {
      return `${diffDays} days`;
    }
    if (diffDays === -1) {
      return '1 day ago';
    }
    return `${Math.abs(diffDays)} days ago`;
  };

  const formatEventDateOnly = (event: SpecialDateEvent) => {
    const isAllDay = isAllDaySpecialDateEvent(event);
    const startDate = isAllDay
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);

    return formatDateOnlyLabel(startDate);
  };

  const formatEventDateLabel = (event: SpecialDateEvent) => {
    return `Event Date: ${formatEventDateOnly(event)}`;
  };

  const formatEventCountdownLabel = (event: SpecialDateEvent) => {
    const isAllDay = isAllDaySpecialDateEvent(event);
    const startDate = isAllDay
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);

    return formatCountdownLabelForDate(startDate);
  };

  const formatEventTimeOnlyLabel = (event: SpecialDateEvent) => {
    if (isAllDaySpecialDateEvent(event)) {
      return 'All day';
    }

    const startDate = new Date(event.eventDateTime);
    const startTimeLabel = startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    const endDateTime = event.eventEndDateTime ? new Date(event.eventEndDateTime) : null;
    if (endDateTime && Number.isFinite(endDateTime.getTime())) {
      return `${startTimeLabel} - ${endDateTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }

    return startTimeLabel;
  };

  const formatEventSummaryRowTimeSuffix = (event: SpecialDateEvent) => (
    isAllDaySpecialDateEvent(event) ? '' : ` • ${formatEventTimeOnlyLabel(event)}`
  );

  const handleSelectEventType = useCallback((nextEventType: EventTypeValue) => {
    const nextIsAllDay = nextEventType === 'birthday' || nextEventType === 'anniversary';
    const nextShowsSubtype = eventTypeHasSubtype(nextEventType);

    setEventTypeDraft(nextEventType);

    setForm((current) => {
      const nextEventDate = new Date(current.eventDateTime);
      const nextReminderDate = new Date(current.reminderDateTime);
      if (nextIsAllDay) {
        nextEventDate.setHours(0, 0, 0, 0);
      }

      const nextSubtypeDraft = getSubtypeValueForEventType(current, nextEventType);
      setSubtypeDraft(nextSubtypeDraft);

      return {
        ...current,
        eventType: nextEventType,
        ageAsOfToday: nextEventType === 'birthday'
          ? (current.ageAsOfToday || getDefaultBirthdayAgeString(nextEventDate))
          : '',
        eventAllDay: nextIsAllDay,
        reminderAllDay: nextIsAllDay ? current.reminderAllDay : false,
        eventDateTime: nextEventDate,
        reminderDateTime: nextReminderDate,
      };
    });

    setHasSelectedEventType(true);
    setIsEventTypePickerVisible(false);
    setHasSelectedSubtype(false);
    setIsSubtypePickerVisible(nextShowsSubtype);
    setValidationMessage(null);
  }, []);

  const handleSelectSubtype = useCallback((nextSubtype: string) => {
    if (!nextSubtype) {
      return;
    }

    setSubtypeDraft(nextSubtype);

    setForm((current) => {
      if (current.eventType === 'party') {
        return {
          ...current,
          partySubtype: nextSubtype as PartySubtypeValue,
          eventAllDay: false,
        };
      }

      if (current.eventType === 'school') {
        return { ...current, schoolSubtype: nextSubtype as SchoolSubtypeValue };
      }

      if (current.eventType === 'medical') {
        return { ...current, medicalSubtype: nextSubtype as MedicalSubtypeValue };
      }

      if (current.eventType === 'dental') {
        return { ...current, dentalSubtype: nextSubtype as DentalSubtypeValue };
      }

      if (current.eventType === 'work') {
        return { ...current, workSubtype: nextSubtype as WorkSubtypeValue };
      }

      return current;
    });

    setHasSelectedSubtype(true);
    setIsSubtypePickerVisible(false);
    setValidationMessage(null);
  }, []);

  const closeTypeSelectionDropdowns = useCallback(() => {
    setIsEventTypePickerVisible(false);
    setIsSubtypePickerVisible(false);
  }, []);

  const openVoiceEventModal = () => {
    Keyboard.dismiss();
    setVoiceTranscriptDraft('');
    setIsVoiceRecording(false);
    setIsVoiceEventModalVisible(true);
  };

  const closeVoiceEventModal = () => {
    if (isVoiceRecording) {
      ExpoSpeechRecognitionModule.stop();
    }
    setIsVoiceRecording(false);
    setVoiceTranscriptDraft('');
    setIsVoiceEventModalVisible(false);
  };

  const startVoiceRecording = async () => {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Microphone access needed',
        'Please allow microphone and speech recognition access in Settings to create events by speaking.',
      );
      return;
    }

    setVoiceTranscriptDraft('');
    setIsVoiceRecording(true);
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: true,
    });
  };

  const stopVoiceRecording = () => {
    ExpoSpeechRecognitionModule.stop();
  };

  const applyVoiceParsedFieldsToForm = (fields: VoiceParsedEventFields) => {
    const validEventTypes: EventTypeValue[] = ['birthday', 'party', 'wedding', 'anniversary', 'medical', 'dental', 'work', 'school', 'travel', 'sports', 'other'];
    const nextEventType = validEventTypes.includes(fields.eventType as EventTypeValue) ? (fields.eventType as EventTypeValue) : null;
    if (nextEventType) {
      handleSelectEventType(nextEventType);
    }

    const subtypeByEventType: Partial<Record<EventTypeValue, { value?: string; valid: string[] }>> = {
      party: { value: fields.partySubtype, valid: ['birthday', 'anniversary', 'retirement', 'engagement', 'holiday', 'other'] },
      school: { value: fields.schoolSubtype, valid: ['quiz', 'test', 'paper-due', 'project-due', 'class-presentation', 'other'] },
      medical: { value: fields.medicalSubtype, valid: ['appointment', 'surgery', 'blood-work', 'radiology', 'rehab', 'other'] },
      dental: { value: fields.dentalSubtype, valid: ['cleaning', 'extraction', 'check-up', 'root-canal', 'bridge', 'dentures', 'cavities', 'implants', 'crown', 'fitting', 'other'] },
      work: { value: fields.workSubtype, valid: ['meeting', 'review', 'conference', 'demo', 'workshop', 'presentation', 'interview', 'other'] },
    };
    const subtypeConfig = nextEventType ? subtypeByEventType[nextEventType] : null;
    if (subtypeConfig?.value && subtypeConfig.valid.includes(subtypeConfig.value)) {
      handleSelectSubtype(subtypeConfig.value);
    }

    const parsedDate = fields.eventDateTimeIso ? new Date(fields.eventDateTimeIso) : null;
    const hasValidDate = Boolean(parsedDate && Number.isFinite(parsedDate.getTime()));
    const parsedEndDate = fields.eventEndDateTimeIso ? new Date(fields.eventEndDateTimeIso) : null;
    const hasValidEndDate = Boolean(parsedEndDate && Number.isFinite(parsedEndDate.getTime()));
    const hasLocation = Boolean(fields.locationName || fields.locationLine1 || fields.locationCity || fields.locationState || fields.locationZip);

    setForm((current) => ({
      ...current,
      ...(fields.customType ? { customType: fields.customType } : {}),
      ...(fields.people ? { people: fields.people } : {}),
      ...(fields.notes ? { notes: fields.notes } : {}),
      ...(hasValidDate ? { eventDateTime: parsedDate as Date } : {}),
      ...(hasValidEndDate ? { eventEndDateTime: parsedEndDate as Date } : {}),
      ...(typeof fields.eventAllDay === 'boolean' ? { eventAllDay: fields.eventAllDay } : {}),
      ...(hasLocation ? {
        eventLocationEnabled: true,
        ...(fields.locationName ? { eventLocationName: fields.locationName } : {}),
        ...(fields.locationLine1 ? { eventLocationLine1: fields.locationLine1, eventLocationFormattedAddress: fields.locationLine1 } : {}),
        ...(fields.locationCity ? { eventLocationCity: fields.locationCity } : {}),
        ...(fields.locationState ? { eventLocationState: normalizeStateCode(fields.locationState) } : {}),
        ...(fields.locationZip ? { eventLocationZip: fields.locationZip } : {}),
      } : {}),
    }));
  };

  const submitVoiceEventText = async () => {
    const text = voiceTranscriptDraft.trim();
    if (!text) {
      Alert.alert('Nothing to use', 'Record or type a description first.');
      return;
    }
    if (!userId || isParsingVoiceEvent) {
      return;
    }

    setIsParsingVoiceEvent(true);
    try {
      const fields = await parseVoiceEventText(userId, text, new Date().toISOString(), effectiveReminderTimeZone);
      if (!fields) {
        Alert.alert('Unable to understand that', 'Please try again, or fill in the fields manually.');
        return;
      }

      applyVoiceParsedFieldsToForm(fields);
      if (isVoiceRecording) {
        ExpoSpeechRecognitionModule.stop();
      }
      setIsVoiceRecording(false);
      setVoiceTranscriptDraft('');
      setIsVoiceEventModalVisible(false);
    } finally {
      setIsParsingVoiceEvent(false);
    }
  };

  const startEditingEvent = (event: SpecialDateEvent) => {
    const now = getDefaultDate();
    setHasInitializedReminderScheduleView(false);
    setHasTouchedStaticReminderSchedule(false);
    setEditingEvent(event);
    setCurrentView('create');
    const eventFormState = getEventFormState(event);
    collapseTypeSelectionUiForEdit(
      eventFormState.eventType,
      getSubtypeValueForEventType(eventFormState, eventFormState.eventType),
    );
    const nextPendingVariableReminders = (event.variableReminders || [])
      .filter((entry) => isFutureReminderDateTime(entry.reminderDateTime))
      .map((entry) => ({
        id: entry.id,
        title: 'Custom reminder',
        people: event.people,
        eventDateTime: event.eventDateTime,
        reminderDateTime: entry.reminderDateTime,
        eventAllDay: event.eventAllDay,
        reminderAllDay: event.reminderAllDay,
        frequency: 'once' as ReminderFrequency,
        notes: event.notes || '',
        notified: false,
      }));

    setPendingVariableReminders(sortVariableReminderDrafts(nextPendingVariableReminders));
    setSeededVariableDraftIds([]);
    setValidationMessage(null);
    setPickerMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setPendingReminderDateTime(new Date(now));
    setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setForm({
      ...eventFormState,
      ageAsOfToday: eventFormState.eventType === 'birthday'
        ? String(event.ageAsOfToday ?? getAgeAsOfToday(getLocalDateFromUtcDay(event.eventDateTime)) ?? '')
        : '',
      people: event.people,
      notes: event.notes || '',
      frequency: event.frequency,
      reminderMode: getReminderModeValue(event),
      eventDateTime: isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime),
      eventEndDateTime: event.eventEndDateTime
        ? new Date(event.eventEndDateTime)
        : getDefaultEndDate(isAllDaySpecialDateEvent(event)
          ? getLocalDateFromUtcDay(event.eventDateTime)
          : new Date(event.eventDateTime)),
      eventAllDay: isAllDaySpecialDateEvent(event),
      reminderDateTime: new Date(now),
      reminderAllDay: event.reminderAllDay,
      reminderTimeZone: effectiveReminderTimeZone,
    });
  };

  const saveEditedEvent = async () => {
    if (!editingEvent || isSavingEvent) return;

    setIsSavingEvent(true);

    try {

      if (!hasSelectedEventType) {
        setValidationMessage('Please choose an event type.');
        return;
      }

      if (eventTypeHasSubtype(form.eventType) && !hasSelectedSubtype) {
        setValidationMessage(`Please choose a ${String(getSubtypeFieldLabel(form.eventType) || 'subtype').toLowerCase()}.`);
        return;
      }

      if (form.eventType === 'other' && !form.customType.trim()) {
        Alert.alert('Missing info', 'Please enter a custom event type.');
        return;
      }

      if (!form.people.trim()) {
        setValidationMessage('Please enter a person, people, group, place, or description.');
        return;
      }

      const ageValue = form.ageAsOfToday.trim();
      const parsedBirthdayAge = ageValue ? Number.parseInt(ageValue, 10) : getAgeAsOfToday(form.eventDateTime);
      if (form.eventType === 'birthday' && parsedBirthdayAge !== null && (!Number.isFinite(parsedBirthdayAge) || parsedBirthdayAge < 0)) {
        setValidationMessage('Please enter a valid age for birthday events.');
        return;
      }

      const selectedReminderDateTime = convertWallDateInTimeZoneToUtcIso(form.reminderDateTime, form.reminderTimeZone);

      const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);

      if (form.reminderMode === 'static' && !isAnnualEvent && new Date(selectedReminderDateTime).getTime() < Date.now()) {
        setValidationMessage('Please choose a reminder time that is in the future.');
        return;
      }

      if (form.reminderMode === 'static' && !pendingVariableReminders.length) {
        setValidationMessage('Press Add Reminder(s) to load recurring reminders into the queue before saving.');
        return;
      }

      setValidationMessage(null);

      const peopleLabel = form.people.trim();
      const notes = form.notes.trim();
      const eventLocation = buildEventLocationFromForm(form);
      if (form.eventLocationSaveEnabled && eventLocation?.name) {
        void persistSavedEventLocation(eventLocation);
      }
      const resolvedEventType = getEventTitle(form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype);
      const reminderFrequency = (form.reminderMode === 'variable' || form.reminderMode === 'default')
        ? 'once' as ReminderFrequency
        : form.frequency;
      const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
      const canUseEventEndTime = supportsEventEndTime(form.eventType, form.partySubtype, form.eventAllDay);
      const eventDateValue = isAnnualEventType(form.eventType, form.partySubtype)
        ? getNextAnnualOccurrenceDate(new Date(form.eventDateTime), isAllDay)
        : new Date(form.eventDateTime);
      const eventEndDateValue = resolveEventEndDateTime(eventDateValue, form.eventEndDateTime);
      const reminderDateValue = new Date(form.reminderDateTime);
      if (isAllDay) {
        eventDateValue.setHours(0, 0, 0, 0);
      }

      if (canUseEventEndTime) {
        eventEndDateValue.setFullYear(
          eventDateValue.getFullYear(),
          eventDateValue.getMonth(),
          eventDateValue.getDate(),
        );

        if (eventEndDateValue.getTime() < eventDateValue.getTime()) {
          setValidationMessage('Event End time cannot be before Event Start time.');
          return;
        }
      }

      if (form.reminderAllDay) {
        reminderDateValue.setHours(0, 0, 0, 0);
      }
      const reminderDateTimeInUtc = convertWallDateInTimeZoneToUtcIso(reminderDateValue, form.reminderTimeZone);

      if (form.reminderMode === 'variable' && pendingVariableReminders.some((item) => (
        !isReminderTimeWithinEventWindow(new Date(item.reminderDateTime), eventDateValue, isAllDay)
      ))) {
        setValidationMessage(isAllDay
          ? 'One or more reminders are set after the day of the event.'
          : 'One or more reminders are set after the event start time.');
        return;
      }

      const duplicateEvent = events.find((event) => event.id !== editingEvent.id && isTrueDuplicateEvent(event, {
        title: resolvedEventType,
        people: peopleLabel,
        eventDateTime: eventDateValue,
        eventAllDay: isAllDay,
      }));

      if (duplicateEvent) {
        const duplicateMessage = getDuplicateEventValidationMessage();
        setValidationMessage(duplicateMessage);
        Alert.alert('Duplicate event', duplicateMessage);
        return;
      }

      const effectivePendingVariableReminders: SpecialDateEvent[] = form.reminderMode === 'default' && !pendingVariableReminders.length
        ? buildDefaultReminderDrafts(
            getDefaultReminderAnchorDate(eventDateValue, isAnnualEvent, isAllDay),
            notes,
            peopleLabel,
            resolvedEventType,
            defaultReminderTime,
          )
        : sortVariableReminderDrafts(pendingVariableReminders);

      const queuedReminderEntries: VariableReminderEntry[] = effectivePendingVariableReminders.map((item) => ({
        id: item.id,
        reminderDateTime: form.reminderMode === 'static'
          ? convertWallDateInTimeZoneToUtcIso(new Date(item.reminderDateTime), form.reminderTimeZone)
          : item.reminderDateTime,
        notes: item.notes || form.notes.trim(),
      }));

      const variableReminderEntries: VariableReminderEntry[] = isNoReminderMode(form.reminderMode)
        ? []
        : form.reminderMode === 'static'
          ? queuedReminderEntries
          : queuedReminderEntries;

      const primaryReminderDateTime = form.reminderMode === 'static' || form.reminderMode === 'default'
        ? variableReminderEntries[0]?.reminderDateTime || reminderDateTimeInUtc
        : variableReminderEntries.length
          ? variableReminderEntries.reduce((earliest, entry) => (
              new Date(entry.reminderDateTime).getTime() < new Date(earliest.reminderDateTime).getTime() ? entry : earliest
            ), variableReminderEntries[0]).reminderDateTime
          : reminderDateTimeInUtc;

      const updatedEvents: SpecialDateEvent[] = events.map((event): SpecialDateEvent =>
        event.id === editingEvent.id
          ? {
              ...event,
              title: resolvedEventType,
              people: peopleLabel,
              ageAsOfToday: form.eventType === 'birthday' && parsedBirthdayAge !== null ? parsedBirthdayAge : undefined,
              eventDateTime: eventDateValue.toISOString(),
              eventEndDateTime: canUseEventEndTime ? eventEndDateValue.toISOString() : undefined,
              reminderDateTime: primaryReminderDateTime,
              eventAllDay: isAllDay,
              reminderAllDay: form.reminderAllDay,
              reminderTimeZone: effectiveReminderTimeZone,
              frequency: reminderFrequency,
              reminderMode: isNoReminderMode(form.reminderMode) ? 'none' : form.reminderMode,
              notes,
              eventLocation,
              notified: false,
              lastReminderTriggeredAt: undefined,
              variableReminders: variableReminderEntries.length ? variableReminderEntries : undefined,
            }
          : event,
      );
      const updatedEvent = updatedEvents.find((event) => event.id === editingEvent.id) || null;

      const wantsShare = form.shareAfterSave;
      const wantsRsvp = form.shareWithRsvp;

      setEvents(updatedEvents);
      setEditingEvent(null);
      resetTypeSelectionUi();
      setPendingVariableReminders([]);
      setSeededVariableDraftIds([]);
      const resetDate = new Date();
      resetDate.setSeconds(0);
      setForm(getResetFormState(effectiveReminderTimeZone));
      setPickerMonth(new Date(resetDate));
      setStaticReminderMonth(new Date(resetDate.getFullYear(), resetDate.getMonth(), 1));
      setPendingReminderDateTime(new Date(resetDate));
      setPendingReminderMonth(new Date(resetDate.getFullYear(), resetDate.getMonth(), 1));
      setViewVersion((value) => value + 1);

      await saveEvents(updatedEvents, userId);
      const reloaded = await loadEvents(userId);
      setEvents(reloaded);
      void autoPushGoogleCalendarIfConfigured();

      await scheduleEventDeviceReminders(
        resolvedEventType,
        peopleLabel,
        isNoReminderMode(form.reminderMode) ? 'none' : form.reminderMode,
        primaryReminderDateTime,
        variableReminderEntries,
      );

      if (updatedEvent) {
        proceedAfterEventEdit(updatedEvent, wantsShare, wantsRsvp);
      } else {
        setCurrentView('manage-events');
      }
    } finally {
      setIsSavingEvent(false);
    }
  };

  const ensureSelectableDateTime = (
    field: 'eventDateTime' | 'eventEndDateTime' | 'reminderDateTime',
    value: Date,
    allDay = false,
  ) => {
    if (allDay) {
      value.setHours(0, 0, 0, 0);
      return value;
    }

    if (field === 'eventDateTime') {
      return value;
    }

    const now = new Date();
    if (value.getTime() <= now.getTime()) {
      value.setTime(now.getTime() + 60 * 60 * 1000);
    }
    return value;
  };

  const updateFieldDateTime = (field: 'eventDateTime' | 'eventEndDateTime' | 'reminderDateTime', nextDate: Date, allDay = false) => {
    setForm((current) => {
      const isAnnualEvent = field === 'eventDateTime' && isAnnualEventType(current.eventType, current.partySubtype);
      const normalizedDate = isAnnualEvent
        ? getNextAnnualOccurrenceDate(new Date(nextDate), isAllDayEvent(current.eventType, current.partySubtype, current.eventAllDay))
        : nextDate;

      const nextValue = ensureSelectableDateTime(field, normalizedDate, allDay);
      if (field !== 'eventDateTime') {
        return { ...current, [field]: nextValue };
      }

      const nextForm = { ...current, eventDateTime: nextValue };
      if (!supportsEventEndTime(current.eventType, current.partySubtype, current.eventAllDay)) {
        return nextForm;
      }

      const nextEventEndDateTime = new Date(resolveEventEndDateTime(nextValue, current.eventEndDateTime));
      nextEventEndDateTime.setFullYear(
        nextValue.getFullYear(),
        nextValue.getMonth(),
        nextValue.getDate(),
      );
      if (nextEventEndDateTime.getTime() < nextValue.getTime()) {
        nextEventEndDateTime.setTime(nextValue.getTime());
      }

      return {
        ...nextForm,
        eventEndDateTime: nextEventEndDateTime,
      };
    });
  };

  const updateFieldTime = (field: 'eventDateTime' | 'eventEndDateTime' | 'reminderDateTime', hours: number, minutes: number) => {
    setForm((current) => {
      const currentValue = current[field];
      const nextDate = currentValue instanceof Date && Number.isFinite(currentValue.getTime())
        ? new Date(currentValue)
        : new Date();
      nextDate.setHours(hours, minutes, 0, 0);
      if (field === 'eventDateTime' && isAnnualEventType(current.eventType, current.partySubtype)) {
        const normalizedDate = getNextAnnualOccurrenceDate(
          nextDate,
          isAllDayEvent(current.eventType, current.partySubtype, current.eventAllDay),
        );
        return { ...current, [field]: ensureSelectableDateTime(field, normalizedDate) };
      }

      const nextValue = ensureSelectableDateTime(field, nextDate);
      if (field !== 'eventDateTime') {
        return { ...current, [field]: nextValue };
      }

      const nextForm = { ...current, eventDateTime: nextValue };
      if (!supportsEventEndTime(current.eventType, current.partySubtype, current.eventAllDay)) {
        return nextForm;
      }

      const nextEventEndDateTime = new Date(resolveEventEndDateTime(nextValue, current.eventEndDateTime));
      nextEventEndDateTime.setFullYear(
        nextValue.getFullYear(),
        nextValue.getMonth(),
        nextValue.getDate(),
      );
      if (nextEventEndDateTime.getTime() < nextValue.getTime()) {
        nextEventEndDateTime.setTime(nextValue.getTime());
      }

      return {
        ...nextForm,
        eventEndDateTime: nextEventEndDateTime,
      };
    });
  };

  const formatTimeLabel = (value: Date) => {
    const hours = value.getHours();
    const minutes = value.getMinutes();
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  const formatReminderTimeDisplay = (value: Date, isSelected: boolean) => {
    if (!isSelected || !Number.isFinite(value.getTime())) {
      return '----:--';
    }

    return formatTimeLabel(value);
  };

  const formatDateTimeLabel = (value: Date, allDay: boolean) => {
    const dateLabel = value.toDateString();
    if (allDay) return dateLabel;
    return dateLabel;
  };

  const getReminderCount = (event: SpecialDateEvent) => {
    return getUpcomingOccurrencesForEvent(event, new Date(), 730).length;
  };

  const getReminderSummaryState = (event: SpecialDateEvent) => {
    const reminderCount = getReminderCount(event);
    return {
      label: `Reminders: ${reminderCount}`,
      count: reminderCount,
      isActive: reminderCount > 0,
    };
  };

  const openRemindersForEvent = (event: SpecialDateEvent) => {
    if (!getReminderSummaryState(event).isActive) {
      return;
    }

    setRemindersForEventId(event.id);
  };

  const beginShareFlowForEvent = (event: SpecialDateEvent) => {
    setSelectedSummaryEventId(null);
    setRemindersForEventId(null);
    setSharingEvent(event);
    setShareManualEmail('');
    setShareManualPhone('');
    setShareRecipients([]);
    setShareMessage('');
    setShareQuickAddPanel(null);
    setShareContactSearch('');
    setValidationMessage(null);
    setCurrentView('share');
  };

  const openRsvpByDatePicker = (event: SpecialDateEvent) => {
    // This screen has no text inputs of its own, but a keyboard left open from whatever the
    // user was doing just before (e.g. typing in the create-event Notes field) can still be
    // showing and cover the calendar when this modal appears on top of it.
    Keyboard.dismiss();
    setSharingEvent(event);
    const defaultDraft = new Date();
    defaultDraft.setHours(0, 0, 0, 0);
    setRsvpByDateDraft(defaultDraft);
    setRsvpPickerMonth(defaultDraft);
    setIsRsvpDatePickerVisible(true);
  };

  const startShareForEvent = (event: SpecialDateEvent) => {
    if (isPartyOrWeddingEvent(event) && !event.rsvpEnabled) {
      Alert.alert(
        'Collect RSVPs?',
        'Would you like to collect RSVPs for this event? Recipients will get a link to accept or decline.',
        [
          { text: 'No', style: 'cancel', onPress: () => beginShareFlowForEvent(event) },
          { text: 'Yes', onPress: () => openRsvpByDatePicker(event) },
        ],
      );
      return;
    }

    beginShareFlowForEvent(event);
  };

  const setEventRsvpSettings = async (eventId: string, rsvpEnabled: boolean, rsvpByDate?: string) => {
    const updated = events.map((event) => (
      event.id === eventId ? { ...event, rsvpEnabled, rsvpByDate } : event
    ));
    setEvents(updated);
    await saveEvents(updated, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    return reloaded.find((event) => event.id === eventId) || updated.find((event) => event.id === eventId) || null;
  };

  const closeRsvpDatePicker = () => {
    setIsRsvpDatePickerVisible(false);
  };

  const selectRsvpByDate = (selectedDay: number) => {
    const nextDate = new Date(rsvpPickerMonth);
    nextDate.setDate(selectedDay);
    nextDate.setHours(0, 0, 0, 0);
    setRsvpByDateDraft(nextDate);
  };

  const confirmRsvpByDate = async () => {
    if (!sharingEvent || isConfirmingRsvpByDate) {
      return;
    }

    setIsConfirmingRsvpByDate(true);
    try {
      const savedEvent = await setEventRsvpSettings(sharingEvent.id, true, rsvpByDateDraft.toISOString());
      setIsRsvpDatePickerVisible(false);
      beginShareFlowForEvent(savedEvent || { ...sharingEvent, rsvpEnabled: true, rsvpByDate: rsvpByDateDraft.toISOString() });
    } finally {
      setIsConfirmingRsvpByDate(false);
    }
  };

  const loadRsvpSummaryForEvent = async (eventId: string) => {
    if (!userId) {
      return;
    }

    const summary = await fetchRsvpSummary(eventId, userId);
    if (summary) {
      setRsvpSummaries((current) => ({ ...current, [eventId]: summary }));
    }
  };

  const getRsvpSummaryLabel = (event: SpecialDateEvent) => {
    const summary = rsvpSummaries[event.id];
    if (!summary) {
      return 'RSVP: —';
    }
    return `RSVP: ${summary.counts.yes} Yes, ${summary.counts.no} No, ${summary.counts.noReply} No Reply`;
  };

  const remindRsvpInvite = async (eventId: string, inviteId: string) => {
    if (!userId || sendingRsvpReminderId) {
      return;
    }

    setSendingRsvpReminderId(inviteId);
    try {
      const result = await sendRsvpReminder(eventId, userId, inviteId);
      if (!result.success) {
        Alert.alert('Unable to send reminder', result.error || 'Please try again later.');
        return;
      }

      if (result.requiresNativeText && result.phone) {
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
          Alert.alert('Text messaging is not available on this device.');
          return;
        }
        await SMS.sendSMSAsync([result.phone], result.message || 'Please RSVP.');
      } else {
        Alert.alert('Reminder sent', 'An RSVP reminder email was sent.');
      }

      await loadRsvpSummaryForEvent(eventId);
    } finally {
      setSendingRsvpReminderId(null);
    }
  };

  const proceedAfterEventSave = (savedEvent: SpecialDateEvent, wantsShare: boolean, wantsRsvp: boolean) => {
    if (wantsRsvp) {
      openRsvpByDatePicker(savedEvent);
      return;
    }
    if (wantsShare) {
      beginShareFlowForEvent(savedEvent);
      return;
    }
    setCurrentView('manage-events');
  };

  const proceedAfterEventEdit = (savedEvent: SpecialDateEvent, wantsShare: boolean, wantsRsvp: boolean) => {
    if (wantsRsvp) {
      openRsvpByDatePicker(savedEvent);
      return;
    }
    if (wantsShare) {
      beginShareFlowForEvent(savedEvent);
      return;
    }
    Alert.alert('Event updated', 'Would you like to modify the reminders for this event?', [
      { text: 'All Good', style: 'cancel', onPress: () => setCurrentView('manage-events') },
      { text: 'Modify Reminders', onPress: () => openReminderEditForEvent(savedEvent) },
    ]);
  };

  const openReminderEditForEvent = (event: SpecialDateEvent) => {
    setSelectedSummaryEventId(null);
    setRemindersForEventId(null);
    setConfirmDeleteReminder(null);
    startEditingEvent(event);
    if (isNoReminderMode(event.reminderMode ?? 'none')) {
      setForm((current) => ({ ...current, reminderMode: 'variable' }));
    }
    setCurrentView('create-reminders');
  };

  const cancelShareFlow = () => {
    setSharingEvent(null);
    setShareManualEmail('');
    setShareManualPhone('');
    setShareRecipients([]);
    setShareMessage('');
    setShareQuickAddPanel(null);
    setShareContactSearch('');
    setValidationMessage(null);
    setCurrentView('manage-events');
  };

  const buildShareDetailsMessage = (
    event: SpecialDateEvent,
    senderName: string,
    customMessage: string,
    acceptLink?: string,
    rsvpRecipient?: { firstName?: string; lastName?: string; email?: string; phone?: string },
  ) => {
    const acceptExplanation = 'As a registered user of the Remind Me This App clicking the Accept link will load the event into your Saved Events folder.';
    const normalizedCustomMessage = customMessage.trim().slice(0, 255);
    const eventDate = isAllDaySpecialDateEvent(event)
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);
    const eventDateLabel = eventDate.toLocaleDateString();
    const eventTimeLabel = formatEventTimeOnlyLabel(event);
    const eventColor = getEventSummaryColor(event);
    const eventIcon = getEventSummaryIcon(event);
    const eventLocationLines = getEventLocationDisplayLines(event.eventLocation);
    const rsvpLink = event.rsvpEnabled ? (() => {
      const baseLink = `${SHARE_ACCEPT_BASE_URL}/rsvp/${event.id}`;
      // Personalize the link per-recipient (when we know who they are) so their RSVP form
      // arrives pre-filled with their name/contact info instead of a blank one — this does
      // mean every recipient gets their own unique link rather than one shared link.
      const params = new URLSearchParams();
      if (rsvpRecipient?.firstName) params.set('firstName', rsvpRecipient.firstName);
      if (rsvpRecipient?.lastName) params.set('lastName', rsvpRecipient.lastName);
      if (rsvpRecipient?.email) params.set('email', rsvpRecipient.email);
      if (rsvpRecipient?.phone) params.set('phone', rsvpRecipient.phone);
      const query = params.toString();
      return query ? `${baseLink}?${query}` : baseLink;
    })() : undefined;
    const rsvpByLabel = event.rsvpByDate ? new Date(event.rsvpByDate).toLocaleDateString() : undefined;

    // Plain-text channels (SMS/iMessage) can't carry background colors, so the event's
    // icon emoji — which renders in color on its own — is the closest equivalent available.
    const textLines = [
      `${eventIcon} ${event.title} — shared with you by ${senderName}.`,
    ];

    if (normalizedCustomMessage) {
      textLines.push(`Message: ${normalizedCustomMessage}`);
    }

    textLines.push(
      `${event.people}`,
      `Event Date: ${eventDateLabel}`,
      `Event Time: ${eventTimeLabel}`,
    );

    if (eventLocationLines.length) {
      textLines.push('Location:', ...eventLocationLines);
    }

    if (acceptLink) {
      textLines.push('');
      textLines.push(acceptExplanation);
      textLines.push('');
      textLines.push(acceptLink);
    }

    if (rsvpLink) {
      textLines.push('');
      textLines.push(rsvpByLabel ? `Please RSVP by ${rsvpByLabel}:` : 'Please RSVP:');
      textLines.push(rsvpLink);
    }

    const htmlSections = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#111827;">',
      `<div style="background-color:${eventColor};color:#ffffff;padding:14px 18px;border-radius:12px;font-size:18px;font-weight:700;margin-bottom:14px;">${escapeHtml(`${eventIcon} ${event.title}`)}</div>`,
      `<div>${escapeHtml(`Shared with you by ${senderName}.`)}</div>`,
    ];

    if (normalizedCustomMessage) {
      htmlSections.push(`<div style="margin-top:8px;">${escapeHtml(`Message: ${normalizedCustomMessage}`)}</div>`);
    }

    htmlSections.push(
      `<div style="margin-top:8px;">${escapeHtml(event.people)}</div>`,
      `<div>${escapeHtml(`Event Date: ${eventDateLabel}`)}</div>`,
      `<div>${escapeHtml(`Event Time: ${eventTimeLabel}`)}</div>`,
    );

    if (eventLocationLines.length) {
      htmlSections.push(`<div style="margin-top:8px;">${escapeHtml('Location:')}</div>`);
      eventLocationLines.forEach((line) => {
        htmlSections.push(`<div>${escapeHtml(line)}</div>`);
      });
    }

    if (acceptLink) {
      htmlSections.push('<div style="height:12px;"></div>');
      htmlSections.push(`<div>${escapeHtml(acceptExplanation)}</div>`);
      htmlSections.push('<div style="height:8px;"></div>');
      htmlSections.push(`<div><a href="${escapeHtml(acceptLink)}">${escapeHtml(acceptLink)}</a></div>`);
    }

    if (rsvpLink) {
      htmlSections.push('<div style="height:12px;"></div>');
      htmlSections.push(`<div style="font-weight:700;">${escapeHtml(rsvpByLabel ? `Please RSVP by ${rsvpByLabel}:` : 'Please RSVP:')}</div>`);
      htmlSections.push(`<div><a href="${escapeHtml(rsvpLink)}" style="color:${eventColor};font-weight:700;">${escapeHtml(rsvpLink)}</a></div>`);
    }

    htmlSections.push('</div>');

    return {
      text: textLines.join('\n'),
      html: htmlSections.join(''),
    };
  };

  const MAX_SHARE_TEXT_RECIPIENTS = 10;

  const handleSendShare = async () => {
    if (isSendingShare) {
      return;
    }
    if (!sharingEvent) {
      setValidationMessage('Please select an event to share.');
      setCurrentView('manage-events');
      return;
    }

    if (!shareRecipients.length) {
      setValidationMessage('Add at least one recipient to the share list.');
      return;
    }

    if (shareMessage.trim().length > 255) {
      setValidationMessage('Message must be 255 characters or fewer.');
      return;
    }

    const currentUser = userId ? await loadUser(userId) : null;
    const senderName = currentUser?.fullName?.trim() || 'A Remind Me This user';

    const currentUserEmail = userEmail?.trim().toLowerCase() || '';
    const currentUserPhoneDigits = (currentUser?.mobileNumber || '').replace(/\D/g, '').slice(0, 10);

    setIsSendingShare(true);
    let launchedAnyChannel = false;
    const deliveryErrors: string[] = [];
    const successfulDeliveries: string[] = [];
    const skippedAlreadyInvited: string[] = [];
    const inviteRecipients = new Set<string>();
    const shareDraftParts: string[] = [];
    const sentEmails = new Set<string>();
    const sentPhonesForTextBatch = new Set<string>();
    const phoneNumbersToText: string[] = [];
    const processedRecipients: ShareRecipient[] = [];

    // If this event is already collecting RSVPs, whoever was already invited before shouldn't
    // get a duplicate invite just because the owner added more people to the list — only the
    // newly added recipients should actually receive anything this time.
    let alreadyInvitedKeys = new Set<string>();
    if (sharingEvent.rsvpEnabled && userId) {
      const existingInvites = await fetchRsvpInvites(sharingEvent.id, userId);
      alreadyInvitedKeys = new Set(
        existingInvites.flatMap((invite) => {
          const keys: string[] = [];
          if (invite.email) {
            keys.push(`email:${invite.email.trim().toLowerCase()}`);
          }
          if (invite.phone) {
            keys.push(`phone:${invite.phone.replace(/\D/g, '').slice(0, 10)}`);
          }
          return keys;
        }),
      );
    }

    for (const recipient of shareRecipients) {
      const normalizedEmail = recipient.email?.trim().toLowerCase() || '';
      const normalizedRecipientPhone = recipient.phone ? recipient.phone.replace(/\D/g, '').slice(0, 10) : '';

      if ((normalizedEmail && currentUserEmail && normalizedEmail === currentUserEmail)
        || (normalizedRecipientPhone && currentUserPhoneDigits && normalizedRecipientPhone === currentUserPhoneDigits)) {
        deliveryErrors.push(`Skipped ${recipient.label}: you cannot share an event with yourself.`);
        continue;
      }

      if (alreadyInvitedKeys.size) {
        const emailKey = normalizedEmail ? `email:${normalizedEmail}` : null;
        const phoneKey = normalizedRecipientPhone ? `phone:${normalizedRecipientPhone}` : null;
        if ((emailKey && alreadyInvitedKeys.has(emailKey)) || (phoneKey && alreadyInvitedKeys.has(phoneKey))) {
          skippedAlreadyInvited.push(recipient.label);
          continue;
        }
      }

      processedRecipients.push(recipient);

      let matchedRecipientUserId = '';
      let acceptLinkForKnownRecipient: string | undefined;

      if (normalizedEmail) {
        const matchedUser = await findUserByEmail(normalizedEmail);
        if (matchedUser?.id) {
          matchedRecipientUserId = matchedUser.id;
          acceptLinkForKnownRecipient = getAcceptLinkForCurrentPlatform(matchedUser.id, sharingEvent.id);
        }
      }

      if (!matchedRecipientUserId && normalizedRecipientPhone) {
        const matchedByPhoneUser = await findUserByPhone(normalizedRecipientPhone);
        if (matchedByPhoneUser?.id) {
          matchedRecipientUserId = matchedByPhoneUser.id;
          acceptLinkForKnownRecipient = getAcceptLinkForCurrentPlatform(matchedByPhoneUser.id, sharingEvent.id);
        }
      }

      const sharePayload = buildShareDetailsMessage(sharingEvent, senderName, shareMessage, acceptLinkForKnownRecipient, {
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        email: normalizedEmail || undefined,
        phone: recipient.phone,
      });

      if (matchedRecipientUserId) {
        inviteRecipients.add(matchedRecipientUserId);
        successfulDeliveries.push(`Popup invite to ${recipient.label}`);
        launchedAnyChannel = true;
      }

      // Even when the recipient already has an account, still send the email so they get an
      // actual notification in their inbox — the in-app invite popup alone is only visible if
      // they happen to open the app while signed in.
      let deliveredToRecipient = false;

      if (normalizedEmail && validateEmail(normalizedEmail)) {
        if (sentEmails.has(normalizedEmail)) {
          deliveryErrors.push(`Skipped duplicate email for ${recipient.label}.`);
        } else {
          sentEmails.add(normalizedEmail);
          const emailSent = await sendShareEmailNotification({
            toEmail: normalizedEmail,
            subject: `Shared event: ${sharingEvent.title}`,
            body: sharePayload.text,
            htmlBody: sharePayload.html,
          });

          if (emailSent) {
            launchedAnyChannel = true;
            deliveredToRecipient = true;
            successfulDeliveries.push(`Email to ${recipient.label}`);
          } else {
            deliveryErrors.push(`Unable to send email to ${recipient.label}.`);
            shareDraftParts.push(`EMAIL\nTo: ${normalizedEmail}\nSubject: Shared event: ${sharingEvent.title}\n\n${sharePayload.text}`);
          }
        }
      }

      // Texting happens once, below, for every recipient with a phone number at once (via the
      // native Messages composer, never Twilio/the backend) rather than per-recipient here —
      // expo-sms only supports handing off one shared message to a batch of numbers, not an
      // automated individual send.
      if (normalizedRecipientPhone && recipient.phone && !validatePhoneNumber(recipient.phone)) {
        if (sentPhonesForTextBatch.has(normalizedRecipientPhone)) {
          deliveryErrors.push(`Skipped duplicate phone for ${recipient.label}.`);
        } else if (phoneNumbersToText.length >= MAX_SHARE_TEXT_RECIPIENTS) {
          deliveryErrors.push(`Skipped texting ${recipient.label}: text sharing supports up to ${MAX_SHARE_TEXT_RECIPIENTS} recipients at a time.`);
        } else {
          sentPhonesForTextBatch.add(normalizedRecipientPhone);
          phoneNumbersToText.push(recipient.phone.trim());
          deliveredToRecipient = true;
        }
      }

      if (!deliveredToRecipient && !matchedRecipientUserId) {
        deliveryErrors.push(`Skipped ${recipient.label}: no valid email or mobile phone was available.`);
      }
    }

    for (const recipientUserId of inviteRecipients) {
      if (!userId) {
        break;
      }

      const inviteCreated = await createShareInvite(
        userId,
        recipientUserId,
        sharingEvent.id,
        shareMessage,
        ['device'],
      );

      if (!inviteCreated) {
        deliveryErrors.push('A recipient invite popup could not be queued right now.');
      }
    }

    if (sharingEvent.rsvpEnabled && userId) {
      if (processedRecipients.length) {
        await sendRsvpInvites(
          sharingEvent.id,
          userId,
          processedRecipients.map((recipient) => ({
            label: recipient.label,
            email: recipient.email || undefined,
            phone: recipient.phone || undefined,
          })),
        );
      }
      await createOrUpdateRsvpShareGroup(sharingEvent, shareRecipients);
    }

    if (!processedRecipients.length && skippedAlreadyInvited.length) {
      setIsSendingShare(false);
      Alert.alert('Already invited', 'Everyone in your list has already received an RSVP invite for this event — no new invites were sent.');
      return;
    }

    // Hand off one native composer with everyone who has a phone number, after the per-
    // recipient emails above. This can't carry per-recipient RSVP personalization (the composer
    // only supports one shared message body across the whole batch), so it uses the plain,
    // un-prefilled link.
    if (phoneNumbersToText.length) {
      try {
        const isAvailable = await SMS.isAvailableAsync();
        if (!isAvailable) {
          deliveryErrors.push('Text messaging is not available on this device.');
        } else {
          const genericSharePayload = buildShareDetailsMessage(sharingEvent, senderName, shareMessage);
          const { result } = await SMS.sendSMSAsync(phoneNumbersToText, genericSharePayload.text);

          if (result === 'sent') {
            launchedAnyChannel = true;
          } else if (result === 'cancelled') {
            deliveryErrors.push('Text composer was cancelled.');
          } else {
            deliveryErrors.push('Unable to confirm whether the text composer was sent.');
          }
        }
      } catch (error) {
        console.error('Sending share texts failed', error);
        deliveryErrors.push('Unable to open the text composer right now.');
      }
    }

    if (!launchedAnyChannel && deliveryErrors.length) {
      const copied = await copyTextToClipboard(shareDraftParts.join('\n\n--------------------\n\n'));
      setValidationMessage(`${deliveryErrors.join(' ')} ${copied ? 'Share draft copied to clipboard.' : 'Copy the share details manually from your message and try again.'}`.trim());
      setIsSendingShare(false);
      return;
    }

    setIsSendingShare(false);
    Alert.alert(
      'Share sent',
      skippedAlreadyInvited.length
        ? `Your event has been shared. ${skippedAlreadyInvited.length} recipient(s) had already been invited and were skipped.`
        : 'Your event has been shared',
    );
    cancelShareFlow();
  };

  const respondToActiveShareInvite = async (action: 'accept' | 'dismiss') => {
    if (!userId || !activeShareInvite || isRespondingToShareInvite) {
      return;
    }

    setIsRespondingToShareInvite(true);
    try {
      const response = await respondToShareInvite(userId, activeShareInvite.id, action);
      if (!response.success) {
        setValidationMessage('Unable to update shared event invitation right now.');
        return;
      }

      if (action === 'accept') {
        await refreshSavedData({ silent: true });
        if (response.duplicate) {
          Alert.alert('Already added', 'This shared event is already in your Saved Events.');
        } else {
          Alert.alert('Shared event added', 'The shared event was added to your Saved Events.');
        }
      }

      await refreshPendingShareInvites();
    } finally {
      setIsRespondingToShareInvite(false);
    }
  };

  const openDatePicker = (target: 'event' | 'reminder') => {
    setPickerTarget(target);
    setPickerMonth(new Date(target === 'event' ? form.eventDateTime : form.reminderDateTime));
  };

  const closeDatePicker = () => setPickerTarget(null);

  const openTimePicker = (target: TimePickerTarget, title: string, value: Date) => {
    const baseDate = target === 'static-reminder'
      ? (isStaticReminderTimeSelected ? new Date(form.reminderDateTime) : new Date())
      : target === 'pending-reminder'
        ? (isVariableReminderTimeSelected ? new Date(pendingReminderDateTime) : new Date())
        : new Date(value);
    const nextDate = new Date(baseDate);
    nextDate.setMinutes(alignMinuteToClockInterval(nextDate.getMinutes(), activeClockIntervalMinutes), 0, 0);
    setTimePickerDraftDate(nextDate);
    setActiveTimePicker({ target, title });
  };

  const closeTimePicker = () => {
    setActiveTimePicker(null);
  };

  const handleSaveTimePicker = (nextDate: Date) => {
    if (!activeTimePicker) {
      return;
    }

    const hours = nextDate.getHours();
    const minutes = alignMinuteToClockInterval(nextDate.getMinutes(), activeClockIntervalMinutes);

    if (activeTimePicker.target === 'event-start') {
      updateFieldTime('eventDateTime', hours, minutes);
      closeTimePicker();
      return;
    }

    if (activeTimePicker.target === 'event-end') {
      updateFieldTime('eventEndDateTime', hours, minutes);
      closeTimePicker();
      return;
    }

    if (activeTimePicker.target === 'static-reminder') {
      const nextReminderDate = new Date();
      nextReminderDate.setHours(hours, minutes, 0, 0);
      setForm((current) => ({
        ...current,
        reminderDateTime: nextReminderDate,
      }));
      setIsStaticReminderTimeSelected(true);
      closeTimePicker();
      return;
    }

    setPendingReminderDateTime(() => {
      const pendingDate = new Date();
      pendingDate.setHours(hours, minutes, 0, 0);
      return pendingDate;
    });
    setIsVariableReminderTimeSelected(true);
    closeTimePicker();
  };

  const cancelCreateFlow = () => {
    const now = getDefaultDate();
    setEditingEvent(null);
    resetTypeSelectionUi();
    setIsEventLocationLine1Focused(false);
    setEventLocationPredictions([]);
    setActiveTimePicker(null);
    setHasInitializedReminderScheduleView(false);
    setHasTouchedStaticReminderSchedule(false);
    setPendingVariableReminders([]);
    setSeededVariableDraftIds([]);
    setPickerMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setPendingReminderDateTime(new Date(0));
    setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setIsStaticReminderTimeSelected(false);
    setIsVariableReminderTimeSelected(false);
    setIsReminderAddedFlash(false);
    setForm(getResetFormState(effectiveReminderTimeZone));
    setValidationMessage(null);
    setCurrentView('manage-events');
  };

  const proceedToReminders = () => {
    if (!hasSelectedEventType) {
      setValidationMessage('Please choose an event type.');
      return;
    }

    if (eventTypeHasSubtype(form.eventType) && !hasSelectedSubtype) {
      setValidationMessage(`Please choose a ${String(getSubtypeFieldLabel(form.eventType) || 'subtype').toLowerCase()}.`);
      return;
    }

    if (form.eventType === 'other' && !form.customType.trim()) {
      Alert.alert('Missing info', 'Please enter a custom event type.');
      return;
    }

    if (!form.people.trim()) {
      setValidationMessage('Please enter a person, people, group, place, or description.');
      return;
    }

    const ageValue = form.ageAsOfToday.trim();
    const parsedBirthdayAge = ageValue ? Number.parseInt(ageValue, 10) : getAgeAsOfToday(form.eventDateTime);
    if (form.eventType === 'birthday' && parsedBirthdayAge !== null && (!Number.isFinite(parsedBirthdayAge) || parsedBirthdayAge < 0)) {
      setValidationMessage('Please enter a valid age for birthday events.');
      return;
    }

    setValidationMessage(null);
    setIsAddRemindersPromptVisible(true);
  };

  const confirmAddModifyReminders = () => {
    setIsAddRemindersPromptVisible(false);
    if (isNoReminderMode(form.reminderMode)) {
      setForm((current) => ({ ...current, reminderMode: 'variable' }));
    }
    setCurrentView('create-reminders');
  };

  const confirmNoReminders = () => {
    setIsAddRemindersPromptVisible(false);
    setPendingNoReminderSave(true);
    setForm((current) => ({ ...current, reminderMode: 'none' }));
  };

  useEffect(() => {
    if (!pendingNoReminderSave || form.reminderMode !== 'none') {
      return;
    }

    setPendingNoReminderSave(false);
    if (editingEvent) {
      void saveEditedEvent();
    } else {
      void saveCurrentEvent();
    }
  }, [pendingNoReminderSave, form.reminderMode, editingEvent]);

  const selectDate = (selectedDay: number) => {
    if (!pickerTarget) return;

    const field = pickerTarget === 'event' ? 'eventDateTime' : 'reminderDateTime';
    const nextDate = new Date(pickerMonth);
    nextDate.setDate(selectedDay);
    const allDay = field === 'eventDateTime'
      ? isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay)
      : form.reminderAllDay;
    if (allDay) {
      nextDate.setHours(0, 0, 0, 0);
    } else {
      nextDate.setHours(form[field].getHours(), form[field].getMinutes(), 0, 0);
    }
    updateFieldDateTime(field, nextDate, allDay);
    closeDatePicker();
  };

  const getCalendarDays = (baseDate: Date) => {
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstOfMonth.getDay();
    const cells: Array<Date | null> = [];

    for (let index = 0; index < startOffset; index += 1) {
      cells.push(null);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push(new Date(year, month, day));
    }

    while (cells.length % 7 !== 0) {
      cells.push(null);
    }

    return cells;
  };

  const calendarDays = useMemo(() => getCalendarDays(pickerMonth), [pickerMonth]);

  const savedEvents = [...events].sort(
    (a, b) => new Date(a.eventDateTime).getTime() - new Date(b.eventDateTime).getTime(),
  );

  const savedEventTypeOptions = useMemo<Array<{ label: string; value: SavedEventsFilterType }>>(
    () => [
      { label: 'All', value: 'all' },
      ...eventTypeOptions,
      { label: 'Public Holidays', value: 'holidays-public' },
      { label: 'Observances', value: 'holidays-observances' },
      { label: 'Religious Holidays', value: 'holidays-religious' },
    ],
    [],
  );

  const toggleSavedEventsFilterType = (value: SavedEventsFilterType) => {
    if (value === 'all') {
      setSavedEventsFilterTypes([]);
      return;
    }
    setSavedEventsFilterTypes((current) => (
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
    ));
  };

  // Subtype filtering only makes sense when exactly one (subtype-capable) type is selected.
  const singleSelectedType: SavedEventsFilterType = savedEventsFilterTypes.length === 1 ? savedEventsFilterTypes[0] : 'all';

  const savedEventsFilterLabel = useMemo(() => {
    if (!savedEventsFilterTypes.length) {
      return 'All';
    }
    return savedEventsFilterTypes
      .map((value) => savedEventTypeOptions.find((option) => option.value === value)?.label)
      .filter(Boolean)
      .join(', ');
  }, [savedEventsFilterTypes, savedEventTypeOptions]);

  const selectedSavedEventsSubtypeLabel = useMemo(() => {
    if (singleSelectedType === 'party') {
      return partySubtypeLabels[savedEventsFilterSubtype as PartySubtypeValue] || '';
    }
    if (singleSelectedType === 'school') {
      return schoolSubtypeLabels[savedEventsFilterSubtype as SchoolSubtypeValue] || '';
    }
    if (singleSelectedType === 'medical') {
      return medicalSubtypeLabels[savedEventsFilterSubtype as MedicalSubtypeValue] || '';
    }
    if (singleSelectedType === 'dental') {
      return dentalSubtypeLabels[savedEventsFilterSubtype as DentalSubtypeValue] || '';
    }
    if (singleSelectedType === 'work') {
      return workSubtypeLabels[savedEventsFilterSubtype as WorkSubtypeValue] || '';
    }
    return '';
  }, [savedEventsFilterSubtype, singleSelectedType]);

  const savedEventsSubtypeOptions = useMemo<Array<{ label: string; value: string }>>(() => {
    if (singleSelectedType === 'party') {
      return [{ label: 'All', value: 'all' }, ...Object.entries(partySubtypeLabels).map(([value, label]) => ({ value, label }))];
    }
    if (singleSelectedType === 'school') {
      return [{ label: 'All', value: 'all' }, ...Object.entries(schoolSubtypeLabels).map(([value, label]) => ({ value, label }))];
    }
    if (singleSelectedType === 'medical') {
      return [{ label: 'All', value: 'all' }, ...Object.entries(medicalSubtypeLabels).map(([value, label]) => ({ value, label }))];
    }
    if (singleSelectedType === 'dental') {
      return [{ label: 'All', value: 'all' }, ...Object.entries(dentalSubtypeLabels).map(([value, label]) => ({ value, label }))];
    }
    if (singleSelectedType === 'work') {
      return [{ label: 'All', value: 'all' }, ...Object.entries(workSubtypeLabels).map(([value, label]) => ({ value, label }))];
    }
    return [{ label: 'All', value: 'all' }];
  }, [singleSelectedType]);

  const shouldShowSavedEventsSubtypeFilter = singleSelectedType !== 'all'
    && singleSelectedType !== 'holidays-public'
    && singleSelectedType !== 'holidays-observances'
    && singleSelectedType !== 'holidays-religious'
    && eventTypeHasSubtype(singleSelectedType);

  const filteredSavedEvents = useMemo(() => {
    return savedEvents.filter((event) => {
      const inferred = getEventFormState(event);
      const inferredType = inferred.eventType;

      if (savedEventsFilterTypes.length && !savedEventsFilterTypes.includes(inferredType)) {
        return false;
      }

      if (!shouldShowSavedEventsSubtypeFilter || savedEventsFilterSubtype === 'all') {
        return true;
      }

      const inferredSubtype = getSubtypeValueForEventType(inferred, inferredType);
      return inferredSubtype === savedEventsFilterSubtype;
    });
  }, [savedEvents, savedEventsFilterSubtype, savedEventsFilterTypes, shouldShowSavedEventsSubtypeFilter]);

  const eventDatesByDay = useMemo(() => {
    const dates = new Set<string>();
    filteredSavedEvents.forEach((event) => {
      const eventDate = isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime);
      dates.add(`${eventDate.getFullYear()}-${eventDate.getMonth()}-${eventDate.getDate()}`);
    });
    return dates;
  }, [filteredSavedEvents]);

  const savedReminders = useMemo(() => {
    if (!events.length) return [];

    const now = new Date();
    const occurrences: Array<{ event: SpecialDateEvent; occurrence: Date }> = [];

    events.forEach((event) => {
      if (isEventExpired(event)) {
        return;
      }

      getUpcomingOccurrencesForEvent(event, now, 365).forEach((occurrence) => {
        occurrences.push({ event, occurrence });
      });
    });

    return occurrences.sort((left, right) => left.occurrence.getTime() - right.occurrence.getTime());
  }, [events]);

  const savedEventsPages = useMemo(() => {
    return filteredSavedEvents.reduce<Array<SpecialDateEvent[]>>((pages, event, index) => {
      const pageIndex = Math.floor(index / 10);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(event);
      return pages;
    }, []);
  }, [filteredSavedEvents]);

  const savedRemindersPages = useMemo(() => {
    return savedReminders.reduce<Array<Array<{ event: SpecialDateEvent; occurrence: Date }>>>((pages, reminder, index) => {
      const pageIndex = Math.floor(index / 10);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(reminder);
      return pages;
    }, []);
  }, [savedReminders]);

  const holidayEntries = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return getHolidayEntries(calendarDefaults, [currentYear, currentYear + 1]);
  }, [calendarDefaults]);

  const filteredHolidayEntriesForCalendar = useMemo(() => (
    holidayEntries.filter((holiday) => {
      if (!savedEventsFilterTypes.length) {
        return true;
      }
      if (savedEventsFilterTypes.includes('holidays-public') && holiday.category === 'us-public') {
        return true;
      }
      if (savedEventsFilterTypes.includes('holidays-observances') && holiday.category === 'observance') {
        return true;
      }
      if (savedEventsFilterTypes.includes('holidays-religious') && holiday.category !== 'us-public' && holiday.category !== 'observance') {
        return true;
      }
      return false;
    })
  ), [holidayEntries, savedEventsFilterTypes]);

  const savedEventsSummaryRows = useMemo(() => {
    const eventRows: SavedEventsSummaryRow[] = filteredSavedEvents.map((event) => {
      const eventDate = isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime);
      return { kind: 'event', id: event.id, date: eventDate, event };
    });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const holidayRows: SavedEventsSummaryRow[] = holidayEntries
      .filter((holiday) => holiday.date.getTime() >= startOfToday.getTime())
      .filter((holiday) => {
        if (!savedEventsFilterTypes.length) {
          return true;
        }
        if (savedEventsFilterTypes.includes('holidays-public') && holiday.category === 'us-public') {
          return true;
        }
        if (savedEventsFilterTypes.includes('holidays-observances') && holiday.category === 'observance') {
          return true;
        }
        if (savedEventsFilterTypes.includes('holidays-religious') && holiday.category !== 'us-public' && holiday.category !== 'observance') {
          return true;
        }
        return false;
      })
      .map((holiday) => ({ kind: 'holiday', id: holiday.id, date: holiday.date, holiday }));

    return [...eventRows, ...holidayRows].sort((left, right) => left.date.getTime() - right.date.getTime());
  }, [filteredSavedEvents, holidayEntries, savedEventsFilterTypes]);

  const savedEventsSummaryPages = useMemo(() => {
    return savedEventsSummaryRows.reduce<Array<SavedEventsSummaryRow[]>>((pages, row, index) => {
      const pageIndex = Math.floor(index / summaryPageSize);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(row);
      return pages;
    }, []);
  }, [savedEventsSummaryRows, summaryPageSize]);

  const savedRemindersSummaryPages = useMemo(() => {
    return savedReminders.reduce<Array<Array<{ event: SpecialDateEvent; occurrence: Date }>>>((pages, reminder, index) => {
      const pageIndex = Math.floor(index / 10);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(reminder);
      return pages;
    }, []);
  }, [savedReminders]);

  const safeSavedEventsPage = Math.min(savedEventsPage, Math.max(0, savedEventsPages.length - 1));
  const safeSavedRemindersPage = Math.min(savedRemindersPage, Math.max(0, savedRemindersPages.length - 1));
  const safeSavedEventsSummaryPage = Math.min(savedEventsSummaryPage, Math.max(0, savedEventsSummaryPages.length - 1));
  const safeSavedRemindersSummaryPage = Math.min(savedRemindersSummaryPage, Math.max(0, savedRemindersSummaryPages.length - 1));
  const currentSavedEventsPageItems = savedEventsPages[safeSavedEventsPage] || [];
  const currentSavedRemindersPageItems = savedRemindersPages[safeSavedRemindersPage] || [];
  const currentSavedEventsSummaryPageItems = savedEventsSummaryPages[safeSavedEventsSummaryPage] || [];
  const currentSavedRemindersSummaryPageItems = savedRemindersSummaryPages[safeSavedRemindersSummaryPage] || [];
  const selectedSummaryEvent = selectedSummaryEventId
    ? events.find((event) => event.id === selectedSummaryEventId) ?? null
    : null;

  useEffect(() => {
    // Always refetch (never rely on a cached count) so a guest changing their RSVP after this
    // was last fetched — e.g. switching Yes to No — is reflected as soon as this card reopens.
    if (selectedSummaryEvent?.rsvpEnabled) {
      void loadRsvpSummaryForEvent(selectedSummaryEvent.id);
    }
  }, [selectedSummaryEvent?.id, selectedSummaryEvent?.rsvpEnabled]);

  const openSummaryEventDetails = (eventId: string) => {
    // Summary taps should always open the action-style event modal, not date/reminder popups.
    setSelectedEventPopupDate(null);
    setSelectedReminderPopup(null);
    setSelectedReminderCalendarDate(null);
    setSelectedReminderDetail(null);
    setRemindersForEventId(null);
    setSelectedSummaryEventId(eventId);
  };

  const selectedDateEntries = useMemo(() => {
    if (!selectedCalendarDate) {
      return [];
    }

    const targetDay = selectedCalendarDate.getDate();
    const targetMonth = selectedCalendarDate.getMonth();
    const targetYear = selectedCalendarDate.getFullYear();
    const entries: Array<{ kind: 'event'; event: SpecialDateEvent } | { kind: 'holiday'; holiday: HolidayEntry }> = [];

    filteredSavedEvents.forEach((event) => {
      const eventDate = isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime);
      if (eventDate.getFullYear() === targetYear && eventDate.getMonth() === targetMonth && eventDate.getDate() === targetDay) {
        entries.push({ kind: 'event', event });
      }
    });

    filteredHolidayEntriesForCalendar.forEach((holiday) => {
      if (holiday.date.getFullYear() === targetYear && holiday.date.getMonth() === targetMonth && holiday.date.getDate() === targetDay) {
        entries.push({ kind: 'holiday', holiday });
      }
    });

    return entries;
  }, [filteredSavedEvents, filteredHolidayEntriesForCalendar, selectedCalendarDate]);

  useEffect(() => {
    if (savedEventsView !== 'calendar') {
      setCalendarMonth(new Date());
      setSelectedCalendarDate(null);
      setExpandedCalendarEventId(null);
    }
  }, [savedEventsView]);

  useEffect(() => {
    if (!shouldShowSavedEventsSubtypeFilter) {
      setSavedEventsFilterSubtype('all');
      setIsSavedEventsSubtypeFilterVisible(false);
      return;
    }

    if (!savedEventsSubtypeOptions.some((option) => option.value === savedEventsFilterSubtype)) {
      setSavedEventsFilterSubtype('all');
    }
  }, [savedEventsFilterSubtype, savedEventsSubtypeOptions, shouldShowSavedEventsSubtypeFilter]);

  useEffect(() => {
    setSavedEventsPage(0);
    setSavedEventsSummaryPage(0);
    setSelectedCalendarDate(null);
    setSelectedEventPopupDate(null);
  }, [savedEventsFilterSubtype, savedEventsFilterTypes]);

  const closeSavedEventsFilters = () => {
    setIsSavedEventsTypeFilterVisible(false);
    setIsSavedEventsSubtypeFilterVisible(false);
  };

  const nextReminderCandidate = useMemo(() => {
    if (!savedReminders.length) return null;
    return savedReminders[0];
  }, [savedReminders]);

  useEffect(() => {
    if (!savedReminders.length) {
      return;
    }

    const firstReminder = savedReminders[0];
    setSavedRemindersCalendarMonth(new Date(firstReminder.occurrence.getFullYear(), firstReminder.occurrence.getMonth(), 1));
  }, [savedReminders]);

  const activeReminderEntry = useMemo(() => {
    if (!activeReminder) {
      return null;
    }

    const match = savedReminders.find(({ event, occurrence }) => event.id === activeReminder.id && occurrence.getTime() === (activeReminder.reminderDateTime ? new Date(activeReminder.reminderDateTime).getTime() : occurrence.getTime()));

    if (match) {
      return match;
    }

    const fallbackOccurrence = activeReminder.reminderDateTime
      ? new Date(activeReminder.reminderDateTime)
      : new Date(activeReminder.eventDateTime);

    return {
      event: activeReminder,
      occurrence: fallbackOccurrence,
    };
  }, [activeReminder, savedReminders]);

  const upcomingReminderDates = useMemo(() => {
    if (!savedReminders.length) return new Set<string>();

    const dates = new Set<string>();
    savedReminders.forEach(({ occurrence }) => {
      dates.add(`${occurrence.getFullYear()}-${occurrence.getMonth()}-${occurrence.getDate()}`);
    });

    return dates;
  }, [savedReminders]);

  const upcomingLabel = useMemo(() => {
    if (!nextReminderCandidate) return 'No upcoming reminders';

    return `${nextReminderCandidate.event.title} • ${nextReminderCandidate.event.people} • ${nextReminderCandidate.occurrence.toLocaleString()}`;
  }, [nextReminderCandidate]);

  const selectedReminderDayEvents = useMemo(() => {
    if (!selectedReminderCalendarDate) {
      return [];
    }

    const targetDay = selectedReminderCalendarDate.getDate();
    const targetMonth = selectedReminderCalendarDate.getMonth();
    const targetYear = selectedReminderCalendarDate.getFullYear();

    return savedReminders.filter(({ occurrence }) => {
      return occurrence.getFullYear() === targetYear
        && occurrence.getMonth() === targetMonth
        && occurrence.getDate() === targetDay;
    });
  }, [savedReminders, selectedReminderCalendarDate]);

  const selectedReminderDetailEntry = useMemo(() => {
    if (!selectedReminderDetail) {
      return null;
    }

    return savedReminders.find(({ event, occurrence }) => (
      event.id === selectedReminderDetail.eventId
      && occurrence.getTime() === selectedReminderDetail.occurrenceTime
    )) || null;
  }, [savedReminders, selectedReminderDetail]);

  const getReminderOccurrencesForEvent = (eventId: string) => {
    return savedReminders.filter(({ event }) => event.id === eventId);
  };

  const generateStaticOccurrencesUpToEventDate = (
    eventDateTime: Date,
    reminderDateTime: Date,
    frequency: ReminderFrequency,
    fromDate: Date,
    maxCount = 730,
  ) => {
    const staticPreviewEvent: SpecialDateEvent = {
      id: 'preview-static-seed',
      title: 'Preview',
      people: form.people || 'You',
      eventDateTime: eventDateTime.toISOString(),
      reminderDateTime: reminderDateTime.toISOString(),
      eventAllDay: form.eventAllDay,
      reminderAllDay: form.reminderAllDay,
      frequency,
      reminderMode: 'static',
      notes: form.notes.trim(),
      notified: false,
    };

    const eventDateBoundary = new Date(eventDateTime);
    eventDateBoundary.setHours(23, 59, 59, 999);

    let nextOccurrence = new Date(reminderDateTime);
    nextOccurrence.setSeconds(0, 0);

    if (frequency !== 'once') {
      let guard = 0;
      while (nextOccurrence.getTime() < fromDate.getTime() && guard < maxCount * 3) {
        const advanced = getNextReminderOccurrence(staticPreviewEvent, nextOccurrence);
        if (advanced.getTime() <= nextOccurrence.getTime()) {
          break;
        }
        nextOccurrence = advanced;
        guard += 1;
      }
    }

    if (frequency === 'once' && nextOccurrence.getTime() < fromDate.getTime()) {
      return [] as Date[];
    }

    const occurrences: Date[] = [];
    let guard = 0;
    while (occurrences.length < maxCount && nextOccurrence.getTime() <= eventDateBoundary.getTime() && guard < maxCount * 4) {
      if (nextOccurrence.getTime() >= fromDate.getTime()) {
        occurrences.push(new Date(nextOccurrence));
      }

      if (frequency === 'once') {
        break;
      }

      const advanced = getNextReminderOccurrence(staticPreviewEvent, nextOccurrence);
      if (advanced.getTime() <= nextOccurrence.getTime()) {
        break;
      }

      nextOccurrence = advanced;
      guard += 1;
    }

    return occurrences;
  };

  const getStaticReminderOccurrencesForForm = () => {
    const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);
    const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
    const normalizedEventDate = isAnnualEvent
      ? getNextAnnualOccurrenceDate(new Date(form.eventDateTime), isAllDay)
      : new Date(form.eventDateTime);
    const normalizedReminderDate = isAnnualEvent
      ? getNextAnnualOccurrenceDate(new Date(form.reminderDateTime), form.reminderAllDay)
      : new Date(form.reminderDateTime);

    return generateStaticOccurrencesUpToEventDate(
      normalizedEventDate,
      normalizedReminderDate,
      form.frequency,
      new Date(),
      12,
    )
      .slice(0, 12);
  };

  const convertOccurrencesToPendingReminders = (occurrences: Date[]) => {
    const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);
    const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
    const normalizedEventDate = isAnnualEvent
      ? getNextAnnualOccurrenceDate(new Date(form.eventDateTime), isAllDay)
      : new Date(form.eventDateTime);

    return occurrences.map((occurrence, index) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`,
      title: 'Custom reminder',
      people: form.people.trim() || 'You',
      eventDateTime: normalizedEventDate.toISOString(),
      reminderDateTime: occurrence.toISOString(),
      eventAllDay: form.eventAllDay,
      reminderAllDay: form.reminderAllDay,
      frequency: 'once' as ReminderFrequency,
      notes: form.notes.trim(),
      notified: false,
    }));
  };

  const getStaticReminderEntriesUpToEventDate = (
    eventDateTime: Date,
    reminderDateTime: Date,
    frequency: ReminderFrequency,
    notes: string,
    additionalEntries: VariableReminderEntry[] = [],
    reminderTimeZone: string = form.reminderTimeZone,
  ) => {
    const eventDateBoundary = new Date(eventDateTime);
    eventDateBoundary.setHours(23, 59, 59, 999);

    const staticOccurrences = generateStaticOccurrencesUpToEventDate(
      eventDateTime,
      reminderDateTime,
      frequency,
      new Date(),
      730,
    );

    const mergedByTime = new Map<number, VariableReminderEntry>();

    staticOccurrences.forEach((occurrence, index) => {
      const reminderDateTimeInUtc = convertWallDateInTimeZoneToUtcIso(occurrence, reminderTimeZone);
      const reminderTime = new Date(reminderDateTimeInUtc).getTime();
      if (!mergedByTime.has(reminderTime)) {
        mergedByTime.set(reminderTime, {
          id: `static-${reminderTime}-${index}`,
          reminderDateTime: reminderDateTimeInUtc,
          notes,
        });
      }
    });

    additionalEntries.forEach((entry) => {
      const entryDate = new Date(entry.reminderDateTime);
      const entryParts = getDateTimePartsForTimeZone(entryDate, reminderTimeZone);
      const entryTimestampInTimeZone = toNaiveTimestamp({
        year: entryParts.year,
        month: entryParts.month - 1,
        day: entryParts.day,
        hour: entryParts.hour,
        minute: entryParts.minute,
        second: entryParts.second,
        millisecond: 0,
      });
      const boundaryTimestampInTimeZone = toNaiveTimestamp({
        year: eventDateBoundary.getFullYear(),
        month: eventDateBoundary.getMonth(),
        day: eventDateBoundary.getDate(),
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
      });

      if (entryTimestampInTimeZone > boundaryTimestampInTimeZone) {
        return;
      }

      const reminderTime = entryDate.getTime();

      if (!mergedByTime.has(reminderTime)) {
        mergedByTime.set(reminderTime, {
          id: entry.id,
          reminderDateTime: entry.reminderDateTime,
          notes: entry.notes || notes,
        });
      }
    });

    return [...mergedByTime.values()].sort((left, right) => (
      new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime()
    ));
  };

  const nextEventTickerMessage = useMemo(() => {
    const now = Date.now();
    const upcomingEvent = [...events]
      .filter((event) => new Date(event.eventDateTime).getTime() >= now)
      .sort((left, right) => new Date(left.eventDateTime).getTime() - new Date(right.eventDateTime).getTime())[0];

    if (!upcomingEvent) {
      return 'No scheduled events';
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    return `${upcomingEvent.title} • ${formatter.format(new Date(upcomingEvent.eventDateTime))}`;
  }, [events]);

  const getOccurrenceDateForReminderCandidate = useCallback((event: SpecialDateEvent, reminderDate: Date) => {
    const baseEventDate = isAllDaySpecialDateEvent(event)
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);
    const targetDate = new Date(baseEventDate);

    switch (event.frequency) {
      case 'daily':
        return new Date(
          reminderDate.getFullYear(),
          reminderDate.getMonth(),
          reminderDate.getDate(),
          targetDate.getHours(),
          targetDate.getMinutes(),
          targetDate.getSeconds(),
          targetDate.getMilliseconds(),
        );
      case 'weekly': {
        const weekStart = new Date(reminderDate);
        weekStart.setHours(0, 0, 0, 0);
        weekStart.setDate(reminderDate.getDate() - reminderDate.getDay());

        const eventDateInSameWeek = new Date(weekStart);
        eventDateInSameWeek.setDate(weekStart.getDate() + baseEventDate.getDay());

        return new Date(
          eventDateInSameWeek.getFullYear(),
          eventDateInSameWeek.getMonth(),
          eventDateInSameWeek.getDate(),
          targetDate.getHours(),
          targetDate.getMinutes(),
          targetDate.getSeconds(),
          targetDate.getMilliseconds(),
        );
      }
      case 'monthly': {
        const daysInMonth = new Date(reminderDate.getFullYear(), reminderDate.getMonth() + 1, 0).getDate();
        const day = Math.min(baseEventDate.getDate(), daysInMonth);
        return new Date(
          reminderDate.getFullYear(),
          reminderDate.getMonth(),
          day,
          targetDate.getHours(),
          targetDate.getMinutes(),
          targetDate.getSeconds(),
          targetDate.getMilliseconds(),
        );
      }
      case 'yearly': {
        const daysInMonth = new Date(reminderDate.getFullYear(), baseEventDate.getMonth() + 1, 0).getDate();
        const day = Math.min(baseEventDate.getDate(), daysInMonth);
        return new Date(
          reminderDate.getFullYear(),
          baseEventDate.getMonth(),
          day,
          targetDate.getHours(),
          targetDate.getMinutes(),
          targetDate.getSeconds(),
          targetDate.getMilliseconds(),
        );
      }
      default:
        return new Date(baseEventDate);
    }
  }, []);

  const nextReminderTickerMessage = useMemo(() => {
    const now = Date.now();
    const nextReminder = events
      .flatMap((event) => getReminderCandidates(event).map((candidate) => ({
        event,
        reminderDate: new Date(candidate.reminderDateTime),
        eventDate: getOccurrenceDateForReminderCandidate(event, new Date(candidate.reminderDateTime)),
      })))
      .filter((entry) => entry.reminderDate.getTime() >= now)
      .sort((left, right) => left.reminderDate.getTime() - right.reminderDate.getTime())[0];

    if (!nextReminder) {
      return 'No scheduled reminders';
    }

    const reminderFormatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const eventFormatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    });

    return `Event: ${eventFormatter.format(nextReminder.eventDate)} • ${nextReminder.event.title} • ${nextReminder.event.people || 'No one listed'} • Reminder: ${reminderFormatter.format(nextReminder.reminderDate)}`;
  }, [events, getOccurrenceDateForReminderCandidate]);

  const widgetSyncPayload = useMemo<WidgetSyncPayload>(() => {
    const now = Date.now();
    const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const dateOnlyFormatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    });

    const upcomingEvent = [...events]
      .filter((event) => new Date(event.eventDateTime).getTime() >= now)
      .sort((left, right) => new Date(left.eventDateTime).getTime() - new Date(right.eventDateTime).getTime())[0];

    const nextEvent = upcomingEvent ? {
      title: upcomingEvent.title,
      people: upcomingEvent.people || '',
      dateLabel: dateTimeFormatter.format(new Date(upcomingEvent.eventDateTime)),
    } : null;

    const nextReminderCandidate = events
      .flatMap((event) => getReminderCandidates(event).map((candidate) => ({
        event,
        reminderDate: new Date(candidate.reminderDateTime),
        eventDate: getOccurrenceDateForReminderCandidate(event, new Date(candidate.reminderDateTime)),
      })))
      .filter((entry) => entry.reminderDate.getTime() >= now)
      .sort((left, right) => left.reminderDate.getTime() - right.reminderDate.getTime())[0];

    const nextReminder = nextReminderCandidate ? {
      title: nextReminderCandidate.event.title,
      people: nextReminderCandidate.event.people || '',
      eventDateLabel: dateOnlyFormatter.format(nextReminderCandidate.eventDate),
      reminderDateLabel: dateTimeFormatter.format(nextReminderCandidate.reminderDate),
    } : null;

    return {
      nextEvent,
      nextReminder,
      updatedAt: new Date().toISOString(),
    };
  }, [events, getOccurrenceDateForReminderCandidate]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !hasLoadedInitialEvents) {
      return;
    }

    try {
      WidgetBridgeModule.setSharedData(WIDGET_APP_GROUP_ID, WIDGET_DATA_KEY, JSON.stringify(widgetSyncPayload));
      WidgetBridgeModule.reloadWidgets();
    } catch (error) {
      console.warn('Widget sync failed', error);
    }
  }, [widgetSyncPayload, hasLoadedInitialEvents]);

  useEffect(() => {
    const handleDeepLink = (url: string | null) => {
      if (url && url.startsWith('remindmethis://')) {
        setCurrentView('manage-events');
      }
    };

    const subscription = Linking.addEventListener('url', (event) => handleDeepLink(event.url));
    Linking.getInitialURL().then(handleDeepLink);

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const nextView = currentView;
    if (nextView === 'manage-events' && previousViewRef.current !== 'manage-events') {
      setLandingTickerVersion((value) => value + 1);
    }
    previousViewRef.current = nextView;
  }, [currentView]);

  useEffect(() => {
    if (currentView !== 'manage-events' || !userId) {
      return;
    }

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(getCalendarDefaultsStorageKey(userId));
        setCalendarDefaults(raw ? normalizeCalendarDefaultsSettings(JSON.parse(raw)) : DEFAULT_CALENDAR_DEFAULTS_SETTINGS);
      } catch (error) {
        console.warn('Unable to load calendar defaults settings', error);
        setCalendarDefaults(DEFAULT_CALENDAR_DEFAULTS_SETTINGS);
      }
    })();
  }, [currentView, userId]);

  useEffect(() => {
    const TICKER_SPEED_PX_PER_SEC = 65;
    const TICKER_END_BUFFER = 20;

    const nextEventEndX = -((nextEventTickerTextWidth || 300) + TICKER_END_BUFFER);
    const nextEventDuration = ((tickerStartX - nextEventEndX) / TICKER_SPEED_PX_PER_SEC) * 1000;

    const nextReminderEndX = -((nextReminderTickerTextWidth || 300) + TICKER_END_BUFFER);
    const nextReminderDuration = ((tickerStartX - nextReminderEndX) / TICKER_SPEED_PX_PER_SEC) * 1000;

    const nextEventAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(nextEventTickerX, {
          toValue: nextEventEndX,
          duration: nextEventDuration,
          useNativeDriver: true,
        }),
        Animated.delay(50),
        Animated.timing(nextEventTickerX, {
          toValue: tickerStartX,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );

    const nextReminderAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(nextReminderTickerX, {
          toValue: nextReminderEndX,
          duration: nextReminderDuration,
          useNativeDriver: true,
        }),
        Animated.delay(50),
        Animated.timing(nextReminderTickerX, {
          toValue: tickerStartX,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );

    nextEventAnimation.start();
    nextReminderAnimation.start();

    return () => {
      nextEventAnimation.stop();
      nextReminderAnimation.stop();
    };
  }, [landingTickerVersion, nextEventTickerX, nextReminderTickerX, nextEventTickerTextWidth, nextReminderTickerTextWidth, tickerStartX]);

  const openNewEventEditor = () => {
    const now = getDefaultDate();
    setHasInitializedReminderScheduleView(false);
    setHasTouchedStaticReminderSchedule(false);
    setEditingEvent(null);
    resetTypeSelectionUi();
    setPendingVariableReminders([]);
    setSeededVariableDraftIds([]);
    setForm(getResetFormState(effectiveReminderTimeZone));
    setPickerMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setPendingReminderDateTime(new Date(now));
    setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setValidationMessage(null);
    setCurrentView('create');
  };

  const renderManageEventsView = () => (
    <View style={styles.manageEventsScreen}>
    <ScrollView
      style={styles.manageEventsScroll}
      contentContainerStyle={[styles.container, savedEventsView === 'summary' && savedEventsSummaryPages.length > 1 && styles.manageEventsScrollContentWithFooter]}
      keyboardShouldPersistTaps="handled"
    >
      {apiStorageStatusMessage ? (
        <View style={styles.apiStatusBanner}>
          <Text style={styles.apiStatusBannerText}>{apiStorageStatusMessage}</Text>
        </View>
      ) : null}

      <View style={[styles.viewControlsRow, styles.viewControlsRowCentered]}>
        <TooltipButton
          label="Create a new event"
          style={[styles.toggleButton, styles.viewControlsCompactButton]}
          onPress={openNewEventEditor}
        >
          {/* A plain "+" glyph (not the ➕ emoji) so it actually respects the white color below —
              emoji render as fixed-color bitmap glyphs and stayed dark/near-invisible in dark mode. */}
          <Text style={[styles.toggleButtonIcon, styles.createEventPlusIcon]}>+</Text>
        </TooltipButton>
        <TooltipButton
          label={savedEventsView === 'calendar' ? 'List View' : 'Calendar View'}
          style={[styles.toggleButton, styles.viewControlsCompactButton]}
          onPress={() => setSavedEventsView(savedEventsView === 'calendar' ? 'summary' : 'calendar')}
        >
          <Text style={styles.toggleButtonIcon}>{savedEventsView === 'calendar' ? '📋' : '📅'}</Text>
        </TooltipButton>
      </View>

      {(isSavedEventsTypeFilterVisible || isSavedEventsSubtypeFilterVisible) ? (
        <Pressable style={styles.dropdownDismissBackdrop} onPress={closeSavedEventsFilters} />
      ) : null}

      <View style={styles.savedEventsFilterRow}>
        <Text style={styles.viewLabel}>Filter</Text>
        <View style={styles.viewControlsGroup}>
          <TouchableOpacity
            style={styles.filterLinkButton}
            onPress={() => {
              setIsSavedEventsSubtypeFilterVisible(false);
              setIsSavedEventsTypeFilterVisible((current) => !current);
            }}
            activeOpacity={0.6}
          >
            <Text style={[styles.filterLinkText, savedEventsFilterTypes.length > 0 && styles.filterLinkTextActive]}>
              Event: {savedEventsFilterLabel}
            </Text>
          </TouchableOpacity>

          {shouldShowSavedEventsSubtypeFilter ? (
            <TouchableOpacity
              style={styles.filterLinkButton}
              onPress={() => {
                setIsSavedEventsTypeFilterVisible(false);
                setIsSavedEventsSubtypeFilterVisible((current) => !current);
              }}
              activeOpacity={0.6}
            >
              <Text style={[styles.filterLinkText, savedEventsFilterSubtype !== 'all' && styles.filterLinkTextActive]}>Subtype: {selectedSavedEventsSubtypeLabel || 'All'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {isSavedEventsTypeFilterVisible ? (
        <View style={styles.filterPillList}>
          {savedEventTypeOptions.map((option) => {
            const optionStyle = getSavedEventsFilterOptionStyle(option.value);
            const isSelected = option.value === 'all' ? savedEventsFilterTypes.length === 0 : savedEventsFilterTypes.includes(option.value);
            const isAllOption = option.value === 'all';

            return (
              <TouchableOpacity
                key={option.value}
                style={[
                  styles.filterPill,
                  isAllOption
                    ? styles.filterPillAll
                    : optionStyle.color ? { backgroundColor: optionStyle.color } : styles.filterPillNeutral,
                  isSelected && styles.filterPillSelected,
                ]}
                onPress={() => {
                  toggleSavedEventsFilterType(option.value);
                  setSavedEventsFilterSubtype('all');
                }}
                activeOpacity={0.8}
              >
                {optionStyle.icon ? <Text style={styles.filterPillIcon}>{optionStyle.icon}</Text> : null}
                <Text
                  style={[
                    styles.filterPillText,
                    isAllOption
                      ? styles.filterPillTextOnBlack
                      : optionStyle.color ? styles.filterPillTextColored : styles.filterPillTextNeutral,
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {shouldShowSavedEventsSubtypeFilter && isSavedEventsSubtypeFilterVisible ? (
        <View style={styles.dropdownList}>
          {savedEventsSubtypeOptions.map((option) => (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.dropdownListItem,
                savedEventsFilterSubtype === option.value && styles.dropdownListItemSelected,
              ]}
              onPress={() => {
                setSavedEventsFilterSubtype(option.value);
                setIsSavedEventsSubtypeFilterVisible(false);
              }}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.dropdownListItemText,
                  savedEventsFilterSubtype === option.value && styles.dropdownListItemTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {savedEventsView === 'summary' ? (
        savedEventsSummaryRows.length ? (
          <>
            {currentSavedEventsSummaryPageItems.map((row) => {
              if (row.kind === 'holiday') {
                const { holiday } = row;
                return (
                  <View key={row.id} style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: holiday.color }]}>
                    <Text style={styles.summaryLinkIcon}>{holiday.icon}</Text>
                    <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
                      {formatDateOnlyLabel(holiday.date)} ({formatCountdownLabelForDate(holiday.date)}) • {holiday.name}
                    </Text>
                  </View>
                );
              }

              const event = row.event;
              const isSelected = selectedSummaryEventId === event.id;
              const selectedEvent = isSelected ? events.find((item) => item.id === event.id) ?? null : null;
              const summaryColor = getEventSummaryColor(event);

              return (
                <View key={row.id}>
                  <TouchableOpacity
                    style={[styles.summaryLink, summaryColor ? [styles.summaryLinkColored, { backgroundColor: summaryColor }] : null]}
                    onPress={() => setSelectedSummaryEventId(isSelected ? null : event.id)}
                    activeOpacity={0.8}
                  >
                    {renderEventSummaryIcon(event)}
                    <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, summaryColor ? styles.summaryLinkTextColored : null]}>
                      {formatEventDateOnly(event)} ({formatEventCountdownLabel(event)}) • {event.title} • {event.people}{formatEventSummaryRowTimeSuffix(event)}
                    </Text>
                  </TouchableOpacity>

                  {selectedEvent ? (
                    <View style={styles.card}>
                      <Text style={styles.label}>{selectedEvent.title}</Text>
                      <Text style={styles.helperText}>{selectedEvent.people}</Text>
                      <Text style={styles.helperText}>{formatEventDateOnly(selectedEvent)}</Text>
                      <Text style={styles.helperText}>{formatEventTimeOnlyLabel(selectedEvent)}</Text>
                      <Text style={styles.helperText}>{selectedEvent.notes || 'No notes'}</Text>
                      <View style={styles.row}>
                        <TouchableOpacity onPress={() => openRemindersForEvent(selectedEvent)}>
                          <Text style={[styles.summaryLinkText, !getReminderSummaryState(selectedEvent).isActive && styles.reminderCountLinkDisabled]}>
                            {getReminderSummaryState(selectedEvent).isActive ? 'View reminders' : 'No reminders'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.helperText}>No saved events yet.</Text>
          </View>
        )
      ) : null}

      {savedEventsView === 'list' ? (
        filteredSavedEvents.length ? (
          <>
            {currentSavedEventsPageItems.map((event) => (
              <View key={event.id} style={styles.card}>
                <Text style={styles.label}>{event.title}</Text>
                <Text style={styles.helperText}>{event.people}</Text>
                <Text style={styles.helperText}>{formatEventDateOnly(event)}</Text>
                <Text style={styles.helperText}>{formatEventTimeOnlyLabel(event)}</Text>
                <View style={styles.row}>
                  <TouchableOpacity onPress={() => setSelectedSummaryEventId(event.id)}>
                    <Text style={styles.summaryLinkText}>Details</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => openRemindersForEvent(event)}>
                    <Text style={[styles.summaryLinkText, !getReminderSummaryState(event).isActive && styles.reminderCountLinkDisabled]}>
                      {getReminderSummaryState(event).isActive ? 'Reminders' : 'No reminders'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}

            {savedEventsPages.length > 1 ? (
              <View style={styles.viewControlsRow}>
                <TouchableOpacity
                  style={styles.toggleButton}
                  onPress={() => setSavedEventsPage((page) => Math.max(0, page - 1))}
                  disabled={safeSavedEventsPage === 0}
                  activeOpacity={0.8}
                >
                  <Text style={styles.toggleButtonText}>Previous</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.toggleButton}
                  onPress={() => setSavedEventsPage((page) => Math.min(savedEventsPages.length - 1, page + 1))}
                  disabled={safeSavedEventsPage >= savedEventsPages.length - 1}
                  activeOpacity={0.8}
                >
                  <Text style={styles.toggleButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.helperText}>No saved events yet.</Text>
          </View>
        )
      ) : null}

      {savedEventsView === 'calendar' ? (
        <View style={[styles.card, styles.calendarViewCard]}>
          <View style={styles.calendarHeader}>
            <TouchableOpacity onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
              <Text style={styles.modalNav}>◀</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
            <TouchableOpacity onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
              <Text style={styles.modalNav}>▶</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <Text key={day} style={styles.weekDay}>{day}</Text>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {getCalendarDays(calendarMonth).map((day, index) => {
              if (!day) {
                return <View key={`empty-${index}`} style={styles.dayCell} />;
              }

              const hasEvent = filteredSavedEvents.some((event) => {
                const eventDate = isAllDaySpecialDateEvent(event)
                  ? getLocalDateFromUtcDay(event.eventDateTime)
                  : new Date(event.eventDateTime);
                return day.toDateString() === eventDate.toDateString();
              });
              const hasHoliday = filteredHolidayEntriesForCalendar.some((holiday) => (
                day.toDateString() === holiday.date.toDateString()
              ));
              const isSelected = selectedCalendarDate && day.toDateString() === selectedCalendarDate.toDateString();
              const isToday = day.toDateString() === new Date().toDateString();

              return (
                <TouchableOpacity
                  key={day.toISOString()}
                  style={[styles.dayCell, hasEvent && styles.dayCellWithEvents, isToday && styles.todayDayCell, isSelected && styles.selectedDayCell]}
                  onPress={() => {
                    setSelectedCalendarDate(day);
                    setSelectedEventPopupDate(null);
                    setExpandedCalendarEventId(null);
                  }}
                >
                  <Text style={[styles.dayText, isToday && styles.todayDayCellText, isSelected && styles.selectedDayText]}>{day.getDate()}</Text>
                  {hasHoliday ? <View style={styles.dayCellHolidayDot} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>

          {selectedCalendarDate ? (
            <View style={styles.calendarDateBelowPanel}>
              {selectedDateEntries.length ? (
                selectedDateEntries.map((entry, index) => {
                  if (entry.kind === 'holiday') {
                    const { holiday } = entry;
                    return (
                      <View
                        key={holiday.id}
                        style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: holiday.color }]}
                      >
                        <Text style={styles.summaryLinkIcon}>{holiday.icon}</Text>
                        <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
                          {holiday.name}
                        </Text>
                      </View>
                    );
                  }

                  const { event } = entry;
                  const isExpanded = expandedCalendarEventId === event.id;

                  if (!isExpanded) {
                    return (
                      <TouchableOpacity
                        key={event.id}
                        style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(event) }]}
                        onPress={() => {
                          setExpandedCalendarEventId(event.id);
                          if (event.rsvpEnabled) {
                            void loadRsvpSummaryForEvent(event.id);
                          }
                        }}
                        activeOpacity={0.8}
                      >
                        {renderEventSummaryIcon(event)}
                        <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
                          {formatEventDateOnly(event)} ({formatEventCountdownLabel(event)}) • {event.title} • {event.people}{formatEventSummaryRowTimeSuffix(event)}
                        </Text>
                      </TouchableOpacity>
                    );
                  }

                  return (
                    <View key={event.id} style={[styles.calendarDateDetailCard, index > 0 && styles.calendarDateDetailCardSpaced]}>
                      <View style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(event) }]}>
                        {renderEventSummaryIcon(event)}
                        <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
                          {formatEventDateOnly(event)} ({formatEventCountdownLabel(event)}) • {event.title} • {event.people}{formatEventSummaryRowTimeSuffix(event)}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => openRemindersForEvent(event)}>
                        <Text style={[styles.savedEventDetailsReminderCounter, !getReminderSummaryState(event).isActive && styles.reminderCountLinkDisabled]}>
                          {getReminderSummaryState(event).isActive ? `Reminders: ${getReminderSummaryState(event).count}` : 'Reminders: 0'}
                        </Text>
                      </TouchableOpacity>
                      {event.rsvpEnabled ? (
                        <TouchableOpacity onPress={() => {
                          setRsvpManagerEventId(event.id);
                          void loadRsvpSummaryForEvent(event.id);
                        }}>
                          <Text style={styles.savedEventDetailsReminderCounter}>{getRsvpSummaryLabel(event)}</Text>
                        </TouchableOpacity>
                      ) : null}
                      {getEventLocationDisplayLines(event.eventLocation).length ? (
                        <View style={styles.savedEventDetailsLocationBlock}>
                          {getEventLocationDisplayLines(event.eventLocation).map((line, index) => (
                            <Text key={index} style={styles.savedEventDetailsMeta}>{line}</Text>
                          ))}
                        </View>
                      ) : null}
                      {event.notes?.trim() ? (
                        <Text style={styles.savedEventDetailsMeta}>Notes: {event.notes.trim()}</Text>
                      ) : null}

                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.savedEventDetailsActionRow}>
                        <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => {
                          setExpandedCalendarEventId(null);
                        }}>
                          <Text style={styles.savedEventDetailActionText}>Close</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => startShareForEvent(event)}>
                          <Text style={styles.savedEventDetailActionText}>Share</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => {
                          startEditingEvent(event);
                          setSelectedCalendarDate(null);
                          setExpandedCalendarEventId(null);
                        }}>
                          <Text style={styles.savedEventDetailActionText}>Modify</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.savedEventDetailActionPillDanger} onPress={() => promptEventDelete(event.id)}>
                          <Text style={styles.savedEventDetailActionTextDanger}>Delete</Text>
                        </TouchableOpacity>
                      </ScrollView>
                    </View>
                  );
                })
              ) : (
                <View style={styles.calendarDateDetailCard}>
                  <Text style={styles.helperText}>No events or holidays on this date.</Text>
                </View>
              )}
            </View>
          ) : (
            <Text style={styles.helperText}>Select a day to view events.</Text>
          )}
        </View>
      ) : null}
    </ScrollView>

    {savedEventsView === 'summary' && savedEventsSummaryPages.length > 1 ? (
      <View style={styles.summaryPaginationRow}>
        <TouchableOpacity
          style={[styles.summaryPagerButton, safeSavedEventsSummaryPage === 0 && styles.summaryPagerButtonDisabled]}
          onPress={() => setSavedEventsSummaryPage((page) => Math.max(0, page - 1))}
          disabled={safeSavedEventsSummaryPage === 0}
          activeOpacity={0.8}
        >
          <Text style={styles.summaryPagerButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.summaryPagerPageText}>Page {safeSavedEventsSummaryPage + 1} of {savedEventsSummaryPages.length}</Text>
        <TouchableOpacity
          style={[styles.summaryPagerButton, safeSavedEventsSummaryPage >= savedEventsSummaryPages.length - 1 && styles.summaryPagerButtonDisabled]}
          onPress={() => setSavedEventsSummaryPage((page) => Math.min(savedEventsSummaryPages.length - 1, page + 1))}
          disabled={safeSavedEventsSummaryPage >= savedEventsSummaryPages.length - 1}
          activeOpacity={0.8}
        >
          <Text style={styles.summaryPagerButtonText}>Next</Text>
        </TouchableOpacity>
      </View>
    ) : null}
    </View>
  );

  const renderManageRemindersView = () => (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={[styles.floatingActionButton, styles.floatingActionSecondaryButton]} onPress={() => setCurrentView('manage-events')} activeOpacity={0.8}>
        <Text style={styles.floatingActionSecondaryText}>Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Manage Reminders</Text>
      <Text style={styles.subtitle}>Review and adjust the reminders attached to your events.</Text>

      {savedReminders.length ? (
        savedReminders.map(({ event, occurrence }) => (
          <View key={`${event.id}-${occurrence.getTime()}`} style={styles.card}>
            <Text style={styles.label}>{event.title}</Text>
            <Text style={styles.helperText}>{event.people}</Text>
            <Text style={styles.helperText}>{occurrence.toLocaleString()}</Text>
          </View>
        ))
      ) : (
        <View style={styles.card}>
          <Text style={styles.helperText}>No reminders scheduled yet.</Text>
        </View>
      )}
    </ScrollView>
  );

  const renderCreateView = () => {
    const effectiveEventEndDateTime = resolveEventEndDateTime(form.eventDateTime, form.eventEndDateTime);
    const subtypeFieldLabel = getSubtypeFieldLabel(form.eventType);
    const subtypeDisplayLabel = getSubtypeDisplayLabel(form);
    const shouldShowSubtypeField = eventTypeHasSubtype(form.eventType);
    const shouldShowAgeAsOfTodayField = hasSelectedEventType && form.eventType === 'birthday';
    const isAnyTypeDropdownVisible = isEventTypePickerVisible || isSubtypePickerVisible;
    const subtypeOptions =
      form.eventType === 'party' ? Object.entries(partySubtypeLabels)
        : form.eventType === 'school' ? Object.entries(schoolSubtypeLabels)
          : form.eventType === 'medical' ? Object.entries(medicalSubtypeLabels)
            : form.eventType === 'dental' ? Object.entries(dentalSubtypeLabels)
              : form.eventType === 'work' ? Object.entries(workSubtypeLabels)
                : [];
    const resolvedEventTypeForPreview = getEventTitle(form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype);
    const isAllDayForPreview = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
    const previewEvent: SpecialDateEvent = {
      id: editingEvent?.id || 'draft-preview',
      title: resolvedEventTypeForPreview,
      people: form.people.trim() || 'You',
      eventDateTime: form.eventDateTime.toISOString(),
      reminderDateTime: form.reminderDateTime.toISOString(),
      eventAllDay: isAllDayForPreview,
      reminderAllDay: form.reminderAllDay,
      frequency: form.frequency,
      reminderMode: form.reminderMode,
      notes: form.notes.trim(),
      notified: false,
    };

    return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>
        {currentView === 'create-reminders' ? 'Reminders' : editingEvent ? 'Modify Event' : 'Create Event'}
      </Text>
      <Text style={styles.subtitle}>
        {currentView === 'create-reminders'
          ? 'Set up how and when you want to be reminded.'
          : editingEvent ? 'Update the event details.' : 'Set up a new event.'}
      </Text>

      {apiStorageStatusMessage ? (
        <View style={styles.apiStatusBanner}>
          <Text style={styles.apiStatusBannerText}>{apiStorageStatusMessage}</Text>
        </View>
      ) : null}

      {currentView === 'create-reminders' ? (
        <View style={styles.card}>
          <Text style={styles.label}>Event</Text>
          <TouchableOpacity
            style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(previewEvent) }]}
            onPress={() => setCurrentView('create')}
            activeOpacity={0.8}
          >
            {renderEventSummaryIcon(previewEvent)}
            <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
              {formatEventDateOnly(previewEvent)} ({formatEventCountdownLabel(previewEvent)}) • {previewEvent.title} • {previewEvent.people}{formatEventSummaryRowTimeSuffix(previewEvent)}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {currentView === 'create' ? (
      <View style={styles.card}>
        {isAnyTypeDropdownVisible ? (
          <Pressable style={styles.dropdownDismissBackdrop} onPress={closeTypeSelectionDropdowns} />
        ) : null}
        <View style={styles.eventTypeHeaderRow}>
          <View style={styles.inlineSelectionRow}>
            <TouchableOpacity
              onPress={() => {
                setEventTypeDraft(hasSelectedEventType ? form.eventType : eventTypeDraft);
                setIsSubtypePickerVisible(false);
                setIsEventTypePickerVisible((current) => !current);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.inlineSelectionValueText}>Event Type</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.voiceMicButton}
            onPress={openVoiceEventModal}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.7}
          >
            <Text style={styles.voiceMicButtonIcon}>🎤</Text>
          </TouchableOpacity>
        </View>
        {isEventTypePickerVisible ? (
          <View style={[styles.filterPillList, styles.filterPillListSpaced]}>
            {eventTypeOptions.map((option) => {
              const optionStyle = getSavedEventsFilterOptionStyle(option.value);
              const isSelected = hasSelectedEventType && form.eventType === option.value;

              return (
                <TouchableOpacity
                  key={option.value}
                  style={[
                    styles.filterPill,
                    optionStyle.color ? { backgroundColor: optionStyle.color } : styles.filterPillNeutral,
                    isSelected && styles.filterPillSelected,
                  ]}
                  onPress={() => handleSelectEventType(option.value)}
                  activeOpacity={0.8}
                >
                  {optionStyle.icon ? <Text style={styles.filterPillIcon}>{optionStyle.icon}</Text> : null}
                  <Text style={[styles.filterPillText, optionStyle.color ? styles.filterPillTextColored : styles.filterPillTextNeutral]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : hasSelectedEventType ? (
          <View style={[styles.filterPillList, styles.filterPillListSpaced]}>
            <TouchableOpacity
              style={[styles.filterPill, { backgroundColor: EVENT_SUMMARY_COLORS[form.eventType] }]}
              onPress={() => {
                setEventTypeDraft(form.eventType);
                setIsSubtypePickerVisible(false);
                setIsEventTypePickerVisible(true);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.filterPillIcon}>{EVENT_SUMMARY_ICONS[form.eventType]}</Text>
              <Text style={[styles.filterPillText, styles.filterPillTextColored]}>{eventTypeLabels[form.eventType]}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {shouldShowSubtypeField && subtypeFieldLabel && hasSelectedEventType ? (
          <>
            <View style={styles.inlineSelectionRow}>
              <TouchableOpacity
                onPress={() => {
                  setSubtypeDraft(getSubtypeValueForEventType(form, form.eventType));
                  setIsEventTypePickerVisible(false);
                  setIsSubtypePickerVisible((current) => !current);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.inlineSelectionValueText}>{subtypeFieldLabel}</Text>
              </TouchableOpacity>
            </View>
            {isSubtypePickerVisible ? (
              <View style={[styles.filterPillList, styles.filterPillListSpaced]}>
                {subtypeOptions.map(([value, label]) => {
                  const isSelected = hasSelectedSubtype && getSubtypeValueForEventType(form, form.eventType) === value;

                  return (
                    <TouchableOpacity
                      key={value}
                      style={[
                        styles.filterPill,
                        { backgroundColor: EVENT_SUMMARY_COLORS[form.eventType] },
                        isSelected && styles.filterPillSelected,
                      ]}
                      onPress={() => handleSelectSubtype(value)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.filterPillText, styles.filterPillTextColored]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : hasSelectedSubtype ? (
              <View style={[styles.filterPillList, styles.filterPillListSpaced]}>
                <TouchableOpacity
                  style={[styles.filterPill, { backgroundColor: EVENT_SUMMARY_COLORS[form.eventType] }]}
                  onPress={() => {
                    setSubtypeDraft(getSubtypeValueForEventType(form, form.eventType));
                    setIsEventTypePickerVisible(false);
                    setIsSubtypePickerVisible(true);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterPillText, styles.filterPillTextColored]}>{subtypeDisplayLabel}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : null}

        {form.eventType === 'other' && (
          <>
            <Text style={styles.label}>Custom event type</Text>
            <TextInput
          placeholderTextColor={colors.textPlaceholder}
              style={styles.input}
              value={form.customType}
              onChangeText={(value) => setForm({ ...form, customType: value })}
              placeholder="Enter a custom event type"
            />
          </>
        )}

        {validationMessage ? (
          <View style={styles.validationBanner}>
            <Text style={styles.validationBannerText}>{validationMessage}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Who/What</Text>
        <TextInput
          placeholderTextColor={colors.textPlaceholder}
          style={styles.input}
          value={form.people}
          onChangeText={(value) => setForm({ ...form, people: value })}
          placeholder="Enter a person, people, group, place or description"
        />

        <View style={styles.shareRsvpRow}>
          <TouchableOpacity
            style={[styles.eventLocationToggleRow, styles.shareRsvpToggle]}
            onPress={() => {
              setForm((current) => {
                const nextShare = !current.shareAfterSave;
                return {
                  ...current,
                  shareAfterSave: nextShare,
                  shareWithRsvp: nextShare ? current.shareWithRsvp : false,
                };
              });
            }}
          >
            <View style={styles.eventLocationRadioOuter}>
              {form.shareAfterSave ? <View style={styles.eventLocationRadioInner} /> : null}
            </View>
            <Text style={styles.eventLocationToggleText}>Share</Text>
          </TouchableOpacity>

          {isPartyOrWeddingEvent(previewEvent) ? (
            <TouchableOpacity
              style={[styles.eventLocationToggleRow, styles.shareRsvpToggle]}
              onPress={() => {
                setForm((current) => {
                  const nextRsvp = !current.shareWithRsvp;
                  return {
                    ...current,
                    shareWithRsvp: nextRsvp,
                    shareAfterSave: nextRsvp ? true : current.shareAfterSave,
                  };
                });
              }}
            >
              <View style={styles.eventLocationRadioOuter}>
                {form.shareWithRsvp ? <View style={styles.eventLocationRadioInner} /> : null}
              </View>
              <Text style={styles.eventLocationToggleText}>with RSVP</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {shouldShowAgeAsOfTodayField ? (
          <>
            <Text style={styles.label}>Age as of today</Text>
            <TextInput
          placeholderTextColor={colors.textPlaceholder}
              style={styles.input}
              value={form.ageAsOfToday}
              onChangeText={(value) => setForm({ ...form, ageAsOfToday: value.replace(/\D/g, '').slice(0, 3) })}
              placeholder="Enter current age"
              keyboardType="number-pad"
              maxLength={3}
            />
          </>
        ) : null}

        {form.eventType !== 'birthday' && form.eventType !== 'anniversary' ? (
          <>
            <Text style={styles.label}>Event address</Text>
            <TouchableOpacity
              style={styles.eventLocationToggleRow}
              onPress={() => {
                setForm((current) => {
                  const nextEnabled = !current.eventLocationEnabled;
                  if (nextEnabled) {
                    return {
                      ...current,
                      eventLocationEnabled: true,
                    };
                  }

                  setIsEventLocationLine1Focused(false);
                  setEventLocationPredictions([]);
                  setIsEventLocationNameFocused(false);
                  return {
                    ...current,
                    eventLocationEnabled: false,
                    eventLocationName: '',
                    eventLocationSaveEnabled: false,
                    eventLocationPlaceId: '',
                    eventLocationFormattedAddress: '',
                    eventLocationLine1: '',
                    eventLocationLine2: '',
                    eventLocationCity: '',
                    eventLocationState: '',
                    eventLocationZip: '',
                    eventLocationPhone: '',
                  };
                });
              }}
            >
              <View style={styles.eventLocationRadioOuter}>
                {form.eventLocationEnabled ? <View style={styles.eventLocationRadioInner} /> : null}
              </View>
              <Text style={styles.eventLocationToggleText}>Set event location address</Text>
            </TouchableOpacity>

            {form.eventLocationEnabled ? (
              <>
                <TextInput
          placeholderTextColor={colors.textPlaceholder}
                  style={styles.input}
                  value={form.eventLocationName}
                  onFocus={() => {
                    if (eventLocationNameBlurTimeoutRef.current) {
                      clearTimeout(eventLocationNameBlurTimeoutRef.current);
                    }
                    setIsEventLocationNameFocused(true);
                  }}
                  onBlur={() => {
                    eventLocationNameBlurTimeoutRef.current = setTimeout(() => {
                      setIsEventLocationNameFocused(false);
                    }, 150);
                  }}
                  onChangeText={(value) => setForm({ ...form, eventLocationName: value })}
                  placeholder="Event Location (e.g. restaurant name)"
                />
                {eventLocationNameSuggestions.length ? (
                  <View style={styles.eventLocationSuggestionsList}>
                    {eventLocationNameSuggestions.map((location) => (
                      <TouchableOpacity
                        key={location.id}
                        style={styles.eventLocationSuggestionItem}
                        onPress={() => applySavedEventLocation(location)}
                      >
                        <Text style={styles.eventLocationSuggestionMainText} numberOfLines={1}>{location.name}</Text>
                        {location.city || location.state ? (
                          <Text style={styles.eventLocationSuggestionSecondaryText} numberOfLines={1}>
                            {[location.city, location.state].filter(Boolean).join(', ')}
                          </Text>
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.eventLocationToggleRow}
                  onPress={() => setForm({ ...form, eventLocationSaveEnabled: !form.eventLocationSaveEnabled })}
                >
                  <View style={styles.eventLocationRadioOuter}>
                    {form.eventLocationSaveEnabled ? <View style={styles.eventLocationRadioInner} /> : null}
                  </View>
                  <Text style={styles.eventLocationToggleText}>Save Location</Text>
                </TouchableOpacity>

                <TextInput
          placeholderTextColor={colors.textPlaceholder}
                  style={styles.input}
                  value={form.eventLocationLine1}
                  onFocus={() => {
                    if (eventLocationBlurTimeoutRef.current) {
                      clearTimeout(eventLocationBlurTimeoutRef.current);
                    }
                    setIsEventLocationLine1Focused(true);
                  }}
                  onBlur={() => {
                    eventLocationBlurTimeoutRef.current = setTimeout(() => {
                      setIsEventLocationLine1Focused(false);
                      setEventLocationPredictions([]);
                    }, 150);
                  }}
                  onChangeText={(value) => setForm((current) => ({
                    ...current,
                    eventLocationLine1: value,
                    eventLocationPlaceId: '',
                    eventLocationFormattedAddress: value,
                  }))}
                  placeholder="Address line 1"
                />
                <TextInput
          placeholderTextColor={colors.textPlaceholder}
                  style={styles.input}
                  value={form.eventLocationLine2}
                  onChangeText={(value) => setForm({ ...form, eventLocationLine2: value })}
                  placeholder="Address line 2"
                />
                {eventLocationPredictions.length ? (
                  <View style={styles.eventLocationSuggestionsList}>
                    {eventLocationPredictions.map((prediction) => (
                      <TouchableOpacity
                        key={prediction.placeId}
                        style={styles.eventLocationSuggestionItem}
                        onPress={() => {
                          void applyEventLocationPrediction(prediction);
                        }}
                      >
                        <Text style={styles.eventLocationSuggestionMainText} numberOfLines={1}>{prediction.mainText}</Text>
                        {prediction.secondaryText ? (
                          <Text style={styles.eventLocationSuggestionSecondaryText} numberOfLines={1}>{prediction.secondaryText}</Text>
                        ) : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
                <TextInput
          placeholderTextColor={colors.textPlaceholder}
                  style={styles.input}
                  value={form.eventLocationCity}
                  onChangeText={(value) => setForm({ ...form, eventLocationCity: value })}
                  placeholder="City"
                />
                <View style={styles.eventLocationCityStateZipRow}>
                  <View style={[styles.eventLocationStatePickerWrapper, styles.eventLocationStateInput]}>
                    <Picker
                      selectedValue={form.eventLocationState}
                      onValueChange={(value) => setForm({ ...form, eventLocationState: String(value || '') })}
                      style={styles.picker}
                    >
                      <Picker.Item label="Select state" value="" />
                      {usStateOptions.map((option) => (
                        <Picker.Item key={option.code} label={option.label} value={option.code} />
                      ))}
                    </Picker>
                  </View>
                  <TextInput
          placeholderTextColor={colors.textPlaceholder}
                    style={[styles.input, styles.eventLocationZipInput]}
                    value={form.eventLocationZip}
                    onChangeText={(value) => setForm({ ...form, eventLocationZip: normalizeZipCode(value) })}
                    placeholder="ZIP"
                    keyboardType="number-pad"
                    maxLength={5}
                  />
                </View>
                <TextInput
          placeholderTextColor={colors.textPlaceholder}
                  style={styles.input}
                  value={form.eventLocationPhone}
                  onChangeText={(value) => setForm({ ...form, eventLocationPhone: formatPhoneNumberInput(value) })}
                  placeholder="(xxx) xxx-xxxx"
                  keyboardType="phone-pad"
                  maxLength={14}
                />
              </>
            ) : null}
          </>
        ) : null}

        <View style={styles.inlineSelectionRow}>
          <Text style={styles.label}>Event date</Text>
          <TouchableOpacity style={styles.inlineSelectionValueButton} onPress={() => openDatePicker('event')} activeOpacity={0.8}>
            <Text style={styles.inlineSelectionValueText}>{formatDateTimeLabel(form.eventDateTime, isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay))}</Text>
          </TouchableOpacity>
        </View>

        {form.eventType !== 'birthday' && form.eventType !== 'anniversary' && form.eventType !== 'party' && (
          <View style={styles.checkboxRow}>
            <TouchableOpacity
              style={styles.checkbox}
              onPress={() => {
                const isBirthday = form.eventType === 'birthday';
                setForm((current) => ({
                  ...current,
                  eventAllDay: isBirthday ? true : !current.eventAllDay,
                }));
              }}
            >
              {isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay) ? <View style={styles.checkboxChecked} /> : <View style={styles.checkboxUnchecked} />}
            </TouchableOpacity>
            <Text style={styles.checkboxLabel}>All day</Text>
          </View>
        )}

        {!form.eventAllDay && form.eventType !== 'birthday' && form.eventType !== 'anniversary' && (
          <>
            {supportsEventEndTime(form.eventType, form.partySubtype, form.eventAllDay) ? (
              <View style={styles.eventTimeGroupsRow}>
                <View style={styles.eventTimeGroup}>
                  <View style={styles.inlineSelectionRow}>
                    <Text style={styles.label}>Start time</Text>
                    <TouchableOpacity
                      style={styles.inlineSelectionValueButton}
                      onPress={() => openTimePicker('event-start', 'Start time', form.eventDateTime)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.inlineSelectionValueText}>{formatTimeLabel(form.eventDateTime)}</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.eventTimeGroup}>
                  <View style={styles.inlineSelectionRow}>
                    <Text style={styles.label}>End time</Text>
                    <TouchableOpacity
                      style={styles.inlineSelectionValueButton}
                      onPress={() => openTimePicker('event-end', 'End time', effectiveEventEndDateTime)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.inlineSelectionValueText}>{formatTimeLabel(effectiveEventEndDateTime)}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.inlineSelectionRow}>
                <Text style={styles.label}>Start time</Text>
                <TouchableOpacity
                  style={styles.inlineSelectionValueButton}
                  onPress={() => openTimePicker('event-start', 'Start time', form.eventDateTime)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.inlineSelectionValueText}>{formatTimeLabel(form.eventDateTime)}</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        <Text style={styles.label}>Notes</Text>
        <TextInput
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, styles.notesInput]}
          multiline
          value={form.notes}
          onChangeText={(value) => setForm({ ...form, notes: value })}
          placeholder="Optional details"
        />

        {validationMessage ? (
          <View style={[styles.validationBanner, { marginTop: 8 }]}>
            <Text style={styles.validationBannerText}>{validationMessage}</Text>
          </View>
        ) : null}

        <View style={styles.floatingActionStripWrap}>
          <View style={styles.floatingActionStripContent}>
            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.floatingActionButton, styles.floatingActionSecondaryButton]}
              onPress={cancelCreateFlow}
            >
              <Text style={styles.floatingActionSecondaryText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.floatingActionButton, styles.floatingActionPrimaryButton]}
              onPress={proceedToReminders}
            >
              <Text style={styles.floatingActionPrimaryText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      ) : null}

      {currentView === 'create-reminders' ? (
      <View style={styles.card}>
        <Text style={styles.label}>Reminder Creation Mode</Text>
        <View style={styles.reminderModeScrollContainer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.reminderModeScrollContent}
            snapToInterval={150}
            decelerationRate="fast"
          >
            {([
              { value: 'default' as ReminderModeValue, label: 'Auto' },
              { value: 'static' as ReminderModeValue, label: 'Recurring' },
              { value: 'variable' as ReminderModeValue, label: 'Custom' },
            ]).map((option) => {
              const isSelected = form.reminderMode === option.value;
              return (
                <Pressable
                  key={option.value}
                  style={[
                    styles.reminderModeScrollButton,
                    isSelected ? styles.reminderModeScrollButtonSelected : styles.reminderModeScrollButtonUnselected,
                  ]}
                  onPress={() => {
                    const now = getDefaultDate();
                    const isFirstReminderModeSelection = isNoReminderMode(form.reminderMode) && isReminderTimeZoneMode(option.value);

                    if (option.value === 'default') {
                      const isAnnualEvent = isAnnualEventType(form.eventType, form.partySubtype);
                      const isAllDay = isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay);
                      const defaultReminderEventDate = getDefaultReminderAnchorDate(form.eventDateTime, isAnnualEvent, isAllDay);

                      const defaultReminders = buildDefaultReminderDrafts(
                        defaultReminderEventDate,
                        form.notes.trim(),
                        form.people.trim(),
                        getEventTitle(form.eventType, form.partySubtype, form.customType, form.schoolSubtype, form.medicalSubtype, form.dentalSubtype, form.workSubtype),
                        defaultReminderTime,
                      );
                      setPendingVariableReminders(defaultReminders);
                      setSeededVariableDraftIds(defaultReminders.map((item) => item.id));
                    }

                    if (option.value !== 'static') {
                      setHasTouchedStaticReminderSchedule(false);
                    }

                    if (isFirstReminderModeSelection) {
                      setPickerMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                      setStaticReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                      setHasTouchedStaticReminderSchedule(false);
                      setPendingReminderDateTime(new Date(now));
                      setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                      setForm((current) => ({
                        ...current,
                        reminderDateTime: new Date(now),
                        reminderMode: option.value,
                      }));
                      return;
                    }

                    setForm({ ...form, reminderMode: option.value });
                  }}
                  onHoverIn={() => setHoveredReminderMode(option.value)}
                  onHoverOut={() => setHoveredReminderMode((current) => (current === option.value ? null : current))}
                  disabled={isSelected && option.value !== 'default'}
                >
                  <Text
                    style={[
                      styles.reminderModeScrollButtonText,
                      isSelected ? styles.reminderModeScrollButtonTextSelected : styles.reminderModeScrollButtonTextUnselected,
                    ]}
                    numberOfLines={1}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {hoveredReminderMode ? (
          <Text style={styles.helperText}>{getReminderModeHoverMessage(hoveredReminderMode)}</Text>
        ) : null}

        {form.reminderMode === 'static' && (
          <>
            <Text style={styles.label}>Reminder frequency</Text>
            <View style={styles.reminderFrequencyScrollContainer}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.reminderModeScrollContent}
                snapToInterval={130}
                decelerationRate="fast"
              >
                {(['daily', 'weekly', 'monthly', 'yearly'] as ReminderFrequency[]).map((option) => {
                  const isSelected = form.frequency === option;
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[
                        styles.reminderModeScrollButton,
                        isSelected ? styles.reminderModeScrollButtonSelected : styles.reminderModeScrollButtonUnselected,
                      ]}
                      onPress={() => setForm({ ...form, frequency: option })}
                      disabled={isSelected}
                    >
                      <Text style={[
                        styles.reminderModeScrollButtonText,
                        isSelected ? styles.reminderModeScrollButtonTextSelected : styles.reminderModeScrollButtonTextUnselected,
                      ]}>
                        {option}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </>
        )}

        {isReminderTimeZoneMode(form.reminderMode) ? (
          <Text style={styles.helperText}>Using account default time zone: {effectiveReminderTimeZone}.</Text>
        ) : null}

        {form.reminderMode === 'default' && (
          <>
            <Text style={styles.label}>Reminder list for this event</Text>
            <Text style={styles.helperText}>Default reminders are automatically generated at {formatReminderTimeLabel(defaultReminderTime.hour, defaultReminderTime.minute)}.</Text>
            {sortVariableReminderDrafts(pendingVariableReminders).length ? (
              sortVariableReminderDrafts(pendingVariableReminders).map((item) => (
                <View key={item.id} style={styles.reminderListItem}>
                  <View style={styles.reminderListRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.reminderListDate}>{item.title}</Text>
                      <Text style={styles.reminderListNotes}>{item.people}</Text>
                      <Text style={styles.reminderListNotes}>{formatDisplayDate(item.reminderDateTime)}</Text>
                      {item.notes ? <Text style={styles.reminderListNotes}>{item.notes}</Text> : null}
                    </View>
                    <TouchableOpacity
                      style={styles.reminderDeleteButton}
                      onPress={() => removePendingVariableReminder(item.id)}
                    >
                      <Text style={styles.reminderDeleteButtonText}>Delete reminder</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            ) : (
              <Text style={styles.helperText}>No default reminders are currently available.</Text>
            )}
          </>
        )}

        {form.reminderMode === 'static' && (
          <>
            <Text style={styles.label}>Reminder schedule</Text>
            <View style={styles.variableReminderLayout}>
              <View style={styles.variableReminderCalendarCard}>
                <View style={styles.variableReminderHeader}>
                  <TouchableOpacity onPress={() => {
                    setHasTouchedStaticReminderSchedule(true);
                    setStaticReminderMonth(new Date(staticReminderMonth.getFullYear(), staticReminderMonth.getMonth() - 1, 1));
                  }}>
                    <Text style={styles.variableReminderNav}>←</Text>
                  </TouchableOpacity>
                  <View style={styles.variableReminderMonthYearWrap}>
                    <Text style={styles.variableReminderYear}>{staticReminderMonth.toLocaleString('default', { year: 'numeric' })}</Text>
                    <Text
                      style={styles.variableReminderMonth}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {staticReminderMonth.toLocaleString('default', { month: 'long' })}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => {
                    setHasTouchedStaticReminderSchedule(true);
                    setStaticReminderMonth(new Date(staticReminderMonth.getFullYear(), staticReminderMonth.getMonth() + 1, 1));
                  }}>
                    <Text style={styles.variableReminderNav}>→</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.weekRow}>
                  {[
                    { key: 'sun', label: 'S' },
                    { key: 'mon', label: 'M' },
                    { key: 'tue', label: 'T' },
                    { key: 'wed', label: 'W' },
                    { key: 'thu', label: 'T' },
                    { key: 'fri', label: 'F' },
                    { key: 'sat', label: 'S' },
                  ].map((day) => (
                    <Text key={day.key} style={styles.weekDay}>{day.label}</Text>
                  ))}
                </View>
                <View style={styles.calendarGrid}>
                  {getCalendarDays(staticReminderMonth).map((day, index) => {
                    if (!day) {
                      return <View key={`empty-${index}`} style={styles.dayCell} />;
                    }

                    const isSelected = day.toDateString() === form.reminderDateTime.toDateString();
                    const isToday = day.toDateString() === new Date().toDateString();

                    return (
                      <TouchableOpacity
                        key={day.toISOString()}
                        style={[styles.dayCell, isSelected && styles.selectedDayCell]}
                        onPress={() => {
                          const nextDate = new Date(form.reminderDateTime);
                          nextDate.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
                          setHasTouchedStaticReminderSchedule(true);
                          updateFieldDateTime('reminderDateTime', nextDate);
                          setStaticReminderMonth(new Date(day.getFullYear(), day.getMonth(), 1));
                        }}
                      >
                        <Text style={[styles.dayText, isToday && styles.todayText, isSelected && styles.selectedDayText]}>
                          {day.getDate()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.variableReminderClockCard}>
                <Text style={styles.label}>Reminder time</Text>
                <TouchableOpacity
                  style={styles.timeValueButton}
                  onPress={() => openTimePicker('static-reminder', 'Reminder time', form.reminderDateTime)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.timeValueButtonText}>{formatReminderTimeDisplay(form.reminderDateTime, isStaticReminderTimeSelected)}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryButton, !isStaticReminderTimeSelected && styles.actionButtonDisabled]}
                  onPress={addPendingVariableReminder}
                  disabled={!isStaticReminderTimeSelected}
                >
                  <Text style={styles.addReminderButtonText}>{isReminderAddedFlash ? 'Reminder Added' : 'Add\nReminder(s)'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {form.reminderMode === 'variable' ? (
          <>
            <Text style={styles.label}>Reminder schedule</Text>
            <View style={styles.variableReminderLayout}>
              <View style={styles.variableReminderCalendarCard}>
                <View style={styles.variableReminderHeader}>
                  <TouchableOpacity onPress={() => setPendingReminderMonth(new Date(pendingReminderMonth.getFullYear(), pendingReminderMonth.getMonth() - 1, 1))}>
                    <Text style={styles.variableReminderNav}>←</Text>
                  </TouchableOpacity>
                  <View style={styles.variableReminderMonthYearWrap}>
                    <Text style={styles.variableReminderYear}>{pendingReminderMonth.toLocaleString('default', { year: 'numeric' })}</Text>
                    <Text
                      style={styles.variableReminderMonth}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.72}
                    >
                      {pendingReminderMonth.toLocaleString('default', { month: 'long' })}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setPendingReminderMonth(new Date(pendingReminderMonth.getFullYear(), pendingReminderMonth.getMonth() + 1, 1))}>
                    <Text style={styles.variableReminderNav}>→</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.weekRow}>
                  {[
                    { key: 'sun', label: 'S' },
                    { key: 'mon', label: 'M' },
                    { key: 'tue', label: 'T' },
                    { key: 'wed', label: 'W' },
                    { key: 'thu', label: 'T' },
                    { key: 'fri', label: 'F' },
                    { key: 'sat', label: 'S' },
                  ].map((day) => (
                    <Text key={day.key} style={styles.weekDay}>{day.label}</Text>
                  ))}
                </View>
                <View style={styles.calendarGrid}>
                  {getCalendarDays(pendingReminderMonth).map((day, index) => {
                    if (!day) {
                      return <View key={`empty-${index}`} style={styles.dayCell} />;
                    }

                    const isSelected = day.toDateString() === pendingReminderDateTime.toDateString();
                    const isToday = day.toDateString() === new Date().toDateString();

                    return (
                      <TouchableOpacity
                        key={day.toISOString()}
                        style={[styles.dayCell, isSelected && styles.selectedDayCell]}
                        onPress={() => {
                          const nextDate = new Date(pendingReminderDateTime);
                          nextDate.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
                          setPendingReminderDateTime(nextDate);
                          setPendingReminderMonth(new Date(day.getFullYear(), day.getMonth(), 1));
                        }}
                      >
                        <Text style={[styles.dayText, isToday && styles.todayText, isSelected && styles.selectedDayText]}>
                          {day.getDate()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.variableReminderClockCard}>
                <Text style={styles.label}>Reminder time</Text>
                <TouchableOpacity
                  style={styles.timeValueButton}
                  onPress={() => openTimePicker('pending-reminder', 'Reminder time', pendingReminderDateTime)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.timeValueButtonText}>{formatReminderTimeDisplay(pendingReminderDateTime, isVariableReminderTimeSelected)}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, !isVariableReminderTimeSelected && styles.actionButtonDisabled]}
                  onPress={addPendingVariableReminder}
                  disabled={!isVariableReminderTimeSelected}
                >
                  <Text style={styles.addReminderButtonText}>{isReminderAddedFlash ? 'Reminder Added' : 'Add\nReminder(s)'}</Text>
                </TouchableOpacity>
              </View>
            </View>

          </>
        ) : null}

        {(form.reminderMode === 'static' || form.reminderMode === 'variable') && (
          <>
            <Text style={styles.label}>Reminder list for this event</Text>
            <Text style={styles.helperText}>All reminders in this list are associated with this event.</Text>

            {form.reminderMode === 'static' ? (
              (() => {
                const staticOccurrences = getStaticReminderOccurrencesForForm();
                const queuedStaticItems = sortVariableReminderDrafts(
                  pendingVariableReminders.filter((item) => isFutureReminderDateTime(item.reminderDateTime)),
                );

                return (
                  <>
                    <Text style={styles.helperText}>
                      {queuedStaticItems.length} reminder{queuedStaticItems.length === 1 ? '' : 's'} currently queued for save.
                    </Text>
                    {queuedStaticItems.map((item) => (
                      <View
                        key={`${item.id}-${item.reminderDateTime}`}
                        style={styles.pendingReminderCard}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.pendingReminderText}>{new Date(item.reminderDateTime).toLocaleString()}</Text>
                        </View>
                        <TouchableOpacity
                          onPress={() => removePendingVariableReminder(item.id)}
                        >
                          <Text style={styles.pendingReminderRemove}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </>
                );
              })()
            ) : null}

            {form.reminderMode === 'variable' ? sortVariableReminderDrafts(pendingVariableReminders.filter((item) => isFutureReminderDateTime(item.reminderDateTime))).map((item) => (
              <View key={`${item.id}-${item.reminderDateTime}`} style={styles.pendingReminderCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pendingReminderText}>{new Date(item.reminderDateTime).toLocaleString()}</Text>
                </View>
                <TouchableOpacity onPress={() => removePendingVariableReminder(item.id)}>
                  <Text style={styles.pendingReminderRemove}>Remove</Text>
                </TouchableOpacity>
              </View>
            )) : null}
          </>
        )}

        {validationMessage ? (
          <View style={[styles.validationBanner, { marginTop: 8 }]}>
            <Text style={styles.validationBannerText}>{validationMessage}</Text>
          </View>
        ) : null}

        <View style={styles.floatingActionStripWrap}>
          <View style={styles.floatingActionStripContent}>
            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.floatingActionButton, styles.floatingActionSecondaryButton, isSavingEvent && styles.actionButtonDisabled]}
              onPress={cancelCreateFlow}
              disabled={isSavingEvent}
            >
              <Text style={styles.floatingActionSecondaryText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.floatingActionButton, styles.floatingActionPrimaryButton, isSavingEvent && styles.actionButtonDisabled]}
              disabled={isSavingEvent}
              onPress={() => {
                if (editingEvent) {
                  void saveEditedEvent();
                } else {
                  void saveCurrentEvent();
                }
              }}
            >
              <Text style={styles.floatingActionPrimaryText}>{isSavingEvent ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      ) : null}

      <Modal transparent visible={pickerTarget !== null} animationType="fade" onRequestClose={closeDatePicker}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setPickerMonth(new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() - 1, 1))}>
                <Text style={styles.modalNav}>◀</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>{pickerMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
              <TouchableOpacity onPress={() => setPickerMonth(new Date(pickerMonth.getFullYear(), pickerMonth.getMonth() + 1, 1))}>
                <Text style={styles.modalNav}>▶</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.weekRow}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <Text key={day} style={styles.weekDay}>{day}</Text>
              ))}
            </View>

            <View style={styles.calendarGrid}>
              {calendarDays.map((day, index) => {
                if (!day) {
                  return <View key={`empty-${index}`} style={styles.dayCell} />;
                }

                const isSelected = day.toDateString() === (pickerTarget === 'event' ? form.eventDateTime : form.reminderDateTime).toDateString();
                const isToday = day.toDateString() === new Date().toDateString();

                return (
                  <TouchableOpacity
                    key={day.toISOString()}
                    style={[styles.dayCell, isSelected && styles.selectedDayCell]}
                    onPress={() => selectDate(day.getDate())}
                  >
                    <Text style={[styles.dayText, isToday && styles.todayText, isSelected && styles.selectedDayText]}>
                      {day.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Button title="Cancel" onPress={closeDatePicker} />
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={isAddRemindersPromptVisible}
        animationType="fade"
        onRequestClose={() => setIsAddRemindersPromptVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add/Modify Reminders</Text>
            <Text style={styles.helperText}>Next, set up reminders for this event.</Text>

            <TouchableOpacity
              style={[styles.floatingActionButton, styles.floatingActionPrimaryButton, { marginTop: 12, alignSelf: 'center' }]}
              onPress={confirmAddModifyReminders}
              activeOpacity={0.8}
            >
              <Text style={styles.floatingActionPrimaryText}>OK</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={confirmNoReminders}
              activeOpacity={0.8}
              style={[styles.floatingActionButton, styles.noRemindersButton, { marginTop: 10, alignSelf: 'center' }]}
            >
              <View style={styles.noRemindersGradientBands} pointerEvents="none">
                <View style={[styles.noRemindersGradientBand, { backgroundColor: '#7b828c' }]} />
                <View style={[styles.noRemindersGradientBand, { backgroundColor: '#6b7280' }]} />
                <View style={[styles.noRemindersGradientBand, { backgroundColor: '#565e6b' }]} />
                <View style={[styles.noRemindersGradientBand, { backgroundColor: '#454c56' }]} />
                <View style={[styles.noRemindersGradientBand, { backgroundColor: '#374151' }]} />
              </View>
              <Text style={styles.floatingActionPrimaryText}>No Reminders</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </ScrollView>
    </KeyboardAvoidingView>
    );
  };

  const renderShareView = () => (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Share Event</Text>
      <Text style={styles.subtitle}>{sharingEvent ? `Share “${sharingEvent.title}” with others.` : 'Choose an event to share.'}</Text>

      {validationMessage ? (
        <View style={styles.validationBanner}>
          <Text style={styles.validationBannerText}>{validationMessage}</Text>
        </View>
      ) : null}

      {sharingEvent ? (
        <View style={styles.card}>
          <Text style={styles.label}>Event</Text>
          <View style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(sharingEvent) }]}>
            {renderEventSummaryIcon(sharingEvent)}
            <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
              {formatEventDateOnly(sharingEvent)} ({formatEventCountdownLabel(sharingEvent)}) • {sharingEvent.title} • {sharingEvent.people}{formatEventSummaryRowTimeSuffix(sharingEvent)}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>Recipients</Text>
        {shareRecipients.length ? (
          shareRecipients.map((recipient) => (
            <View key={recipient.key} style={styles.reminderListItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.reminderListDate}>{recipient.label}</Text>
                {recipient.email ? <Text style={styles.reminderListNotes}>{recipient.email}</Text> : null}
                {recipient.phone ? <Text style={styles.reminderListNotes}>{recipient.phone}</Text> : null}
              </View>
              <TouchableOpacity onPress={() => removeShareRecipient(recipient.key)}>
                <Text style={styles.pendingReminderRemove}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))
        ) : (
          <Text style={styles.helperText}>No recipients added yet.</Text>
        )}

        <View style={styles.savedEventDetailsActionRow}>
          <TouchableOpacity
            style={styles.savedEventDetailActionPill}
            onPress={() => setShareQuickAddPanel((current) => (current === 'contact' ? null : 'contact'))}
          >
            <Text style={styles.savedEventDetailActionText}>Add Contact</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.savedEventDetailActionPill}
            onPress={() => setShareQuickAddPanel((current) => (current === 'group' ? null : 'group'))}
          >
            <Text style={styles.savedEventDetailActionText}>Add Group</Text>
          </TouchableOpacity>
        </View>

        {shareQuickAddPanel === 'contact' ? (
          <View style={styles.dropdownList}>
            <TouchableOpacity
              style={styles.dropdownListItem}
              onPress={() => { void pickDeviceContactForShare(); }}
            >
              <Text style={styles.dropdownListItemText}>📱 Pick from iPhone Contacts</Text>
            </TouchableOpacity>
            {shareSelectableContacts.length ? (
              <TextInput
          placeholderTextColor={colors.textPlaceholder}
                style={[styles.input, styles.shareContactSearchInput]}
                value={shareContactSearch}
                onChangeText={setShareContactSearch}
                placeholder="Search contacts"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
            ) : null}
            {shareSelectableContacts.length ? (
              filteredShareSelectableContacts.length ? (
                filteredShareSelectableContacts.map((contact) => (
                  <TouchableOpacity
                    key={contact.id}
                    style={styles.dropdownListItem}
                    onPress={() => {
                      addContactRecipient(contact);
                      setShareQuickAddPanel(null);
                      setShareContactSearch('');
                    }}
                  >
                    <Text style={styles.dropdownListItemText}>
                      {contact.firstName}{contact.lastName ? ` ${contact.lastName}` : ''}
                    </Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={[styles.helperText, styles.dropdownListItem]}>No contacts match your search.</Text>
              )
            ) : (
              <Text style={[styles.helperText, styles.dropdownListItem]}>No saved contacts yet.</Text>
            )}
          </View>
        ) : null}

        {shareQuickAddPanel === 'group' ? (
          <View style={styles.dropdownList}>
            {shareGroups.length ? (
              shareGroups.map((group) => (
                <TouchableOpacity
                  key={group.id}
                  style={styles.dropdownListItem}
                  onPress={() => {
                    addGroupRecipients(group);
                    setShareQuickAddPanel(null);
                  }}
                >
                  <Text style={styles.dropdownListItemText}>{group.name} ({group.contactIds.length})</Text>
                </TouchableOpacity>
              ))
            ) : (
              <Text style={[styles.helperText, styles.dropdownListItem]}>No groups saved yet. Create one in Settings → Groups.</Text>
            )}
          </View>
        ) : null}

        <Text style={styles.label}>Add email</Text>
        <TextInput
          placeholderTextColor={colors.textPlaceholder}
          style={styles.input}
          value={shareManualEmail}
          onChangeText={setShareManualEmail}
          placeholder="name@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.primaryButton} onPress={addManualEmailRecipient}>
          <Text style={styles.addReminderButtonText}>Add email</Text>
        </TouchableOpacity>

        <Text style={styles.label}>Add phone</Text>
        <TextInput
          placeholderTextColor={colors.textPlaceholder}
          style={styles.input}
          value={shareManualPhone}
          onChangeText={setShareManualPhone}
          placeholder="(555) 123-4567"
          keyboardType="phone-pad"
        />
        <TouchableOpacity style={styles.primaryButton} onPress={addManualPhoneRecipient}>
          <Text style={styles.addReminderButtonText}>Add phone</Text>
        </TouchableOpacity>

        <Text style={styles.label}>Message</Text>
        <TextInput
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, styles.notesInput]}
          multiline
          value={shareMessage}
          onChangeText={setShareMessage}
          placeholder="Optional personal note"
        />
      </View>

      <View style={styles.floatingActionStripWrap}>
        <View style={styles.floatingActionStripContent}>
          <TouchableOpacity
            activeOpacity={0.8}
            style={[styles.floatingActionButton, styles.floatingActionSecondaryButton, isSendingShare && styles.actionButtonDisabled]}
            onPress={cancelShareFlow}
            disabled={isSendingShare}
          >
            <Text style={styles.floatingActionSecondaryText}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.8}
            style={[styles.floatingActionButton, styles.floatingActionPrimaryButton, isSendingShare && styles.actionButtonDisabled]}
            onPress={() => void handleSendShare()}
            disabled={isSendingShare}
          >
            <Text style={styles.floatingActionPrimaryText}>{isSendingShare ? 'Sending…' : 'Send'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );

  const activeEventSummaryModal = selectedSummaryEvent ? (
    <Modal transparent visible={Boolean(selectedSummaryEvent)} animationType="fade" onRequestClose={() => setSelectedSummaryEventId(null)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, styles.savedEventDetailsCard]}>
          <Text style={styles.savedEventDetailsTitle}>Event details</Text>
          <Text style={styles.savedEventDetailsEventTitle}>{selectedSummaryEvent.title}</Text>
          <View style={styles.savedEventDetailsMetaRow}>
            {getReminderSummaryState(selectedSummaryEvent).isActive ? (
              <TouchableOpacity onPress={() => {
                const eventId = selectedSummaryEvent.id;
                setSelectedSummaryEventId(null);
                // Closing this modal and opening another one in the same tick can race with
                // native modal presentation/dismissal on iOS and appear to freeze the UI, so
                // wait for the close animation to finish before opening the next modal.
                setTimeout(() => setRemindersForEventId(eventId), 300);
              }}>
                <Text style={styles.savedEventDetailsReminderCounter}>Reminders: {getReminderSummaryState(selectedSummaryEvent).count}</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.savedEventDetailsReminderCounter}>Reminders: 0</Text>
            )}
            {selectedSummaryEvent.rsvpEnabled ? (
              <TouchableOpacity onPress={() => {
                const eventId = selectedSummaryEvent.id;
                setSelectedSummaryEventId(null);
                setTimeout(() => {
                  setRsvpManagerEventId(eventId);
                  void loadRsvpSummaryForEvent(eventId);
                }, 300);
              }}>
                <Text style={styles.savedEventDetailsReminderCounter}>{getRsvpSummaryLabel(selectedSummaryEvent)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <Text style={styles.savedEventDetailsPeople}>{selectedSummaryEvent.people}</Text>
          <Text style={styles.savedEventDetailsMeta}>Event Date: {formatEventDateOnly(selectedSummaryEvent)}</Text>
          <Text style={styles.savedEventDetailsMeta}>{formatEventTimeOnlyLabel(selectedSummaryEvent)}</Text>
          {getEventLocationDisplayLines(selectedSummaryEvent.eventLocation).length ? (
            <View style={styles.savedEventDetailsLocationBlock}>
              {getEventLocationDisplayLines(selectedSummaryEvent.eventLocation).map((line, index) => (
                <Text key={index} style={styles.savedEventDetailsMeta}>{line}</Text>
              ))}
            </View>
          ) : null}
          {selectedSummaryEvent.notes?.trim() ? (
            <Text style={styles.savedEventDetailsMeta}>Notes: {selectedSummaryEvent.notes.trim()}</Text>
          ) : null}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.savedEventDetailsActionRow}
          >
            <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => setSelectedSummaryEventId(null)}>
              <Text style={styles.savedEventDetailActionText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => startShareForEvent(selectedSummaryEvent)}>
              <Text style={styles.savedEventDetailActionText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => {
              startEditingEvent(selectedSummaryEvent);
              setSelectedSummaryEventId(null);
            }}>
              <Text style={styles.savedEventDetailActionText}>Modify</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.savedEventDetailActionPillDanger} onPress={() => promptEventDelete(selectedSummaryEvent.id)}>
              <Text style={styles.savedEventDetailActionTextDanger}>Delete</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  ) : null;

  const reminderEventModal = remindersForEventId && events.find((event) => event.id === remindersForEventId)
    ? (() => {
        const reminderEvent = events.find((event) => event.id === remindersForEventId)!;
        const reminderEntries = getReminderOccurrencesForEvent(reminderEvent.id);
        const REMINDERS_MODAL_PAGE_SIZE = 4;
        const reminderPages: typeof reminderEntries[] = [];
        for (let index = 0; index < reminderEntries.length; index += REMINDERS_MODAL_PAGE_SIZE) {
          reminderPages.push(reminderEntries.slice(index, index + REMINDERS_MODAL_PAGE_SIZE));
        }
        const safeRemindersModalPage = Math.min(remindersModalPage, Math.max(0, reminderPages.length - 1));
        const currentReminderPageItems = reminderPages[safeRemindersModalPage] || [];
        return (
          <Modal transparent visible={Boolean(remindersForEventId)} animationType="fade" onRequestClose={() => setRemindersForEventId(null)}>
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.savedEventDetailsCard]}>
                <Text style={styles.savedEventDetailsTitle}>Scheduled reminders</Text>
                {reminderEntries.length ? currentReminderPageItems.map(({ event, occurrence }) => {
                  const matchingReminderEntry = (event.variableReminders || []).find((entry) => (
                    new Date(entry.reminderDateTime).getTime() === occurrence.getTime()
                  ));

                  return (
                    <View key={`${event.id}-${occurrence.getTime()}`} style={styles.savedReminderItemCard}>
                      <TouchableOpacity style={styles.savedReminderDeleteButton} onPress={() => {
                        promptReminderDelete(
                          event.id,
                          matchingReminderEntry?.id || (event.variableReminders || [])[0]?.id,
                          event.reminderMode === 'static' ? 'static' : 'variable',
                          'reminder',
                        );
                      }}>
                        <Text style={styles.savedReminderDeleteButtonText}>Delete</Text>
                      </TouchableOpacity>
                      <View style={styles.savedReminderItemHeader}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.savedReminderItemTitle}>{event.title} • {event.people}</Text>
                          <Text style={styles.savedReminderItemSubtext}>Reminder: {occurrence.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</Text>
                          <Text style={styles.savedReminderItemSubtext}>Event date: {formatEventDateOnly(event)}</Text>
                        </View>
                      </View>
                    </View>
                  );
                }) : (
                  <Text style={styles.helperText}>No current reminders.</Text>
                )}

                {reminderPages.length > 1 ? (
                  <View style={styles.summaryPaginationRow}>
                    <TouchableOpacity
                      style={[styles.summaryPagerButton, safeRemindersModalPage === 0 && styles.summaryPagerButtonDisabled]}
                      onPress={() => setRemindersModalPage((page) => Math.max(0, page - 1))}
                      disabled={safeRemindersModalPage === 0}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.summaryPagerButtonText}>Back</Text>
                    </TouchableOpacity>
                    <Text style={styles.summaryPagerPageText}>Page {safeRemindersModalPage + 1} of {reminderPages.length}</Text>
                    <TouchableOpacity
                      style={[styles.summaryPagerButton, safeRemindersModalPage >= reminderPages.length - 1 && styles.summaryPagerButtonDisabled]}
                      onPress={() => setRemindersModalPage((page) => Math.min(reminderPages.length - 1, page + 1))}
                      disabled={safeRemindersModalPage >= reminderPages.length - 1}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.summaryPagerButtonText}>Next</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                <View style={styles.savedReminderActionsWrap}>
                  <TouchableOpacity style={styles.savedReminderPrimaryButton} onPress={() => {
                    const eventToEdit = events.find((event) => event.id === reminderEvent.id);
                    if (eventToEdit) {
                      openReminderEditForEvent(eventToEdit);
                    }
                  }}>
                    <Text style={styles.savedReminderPrimaryButtonText}>Add Reminder(s)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.savedReminderDangerButton} onPress={() => {
                    promptReminderDelete(reminderEvent.id, undefined, undefined, 'all-reminders');
                  }}>
                    <Text style={styles.savedReminderDangerButtonText}>Delete All Reminders</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => {
                    setSelectedSummaryEventId(reminderEvent.id);
                    setRemindersForEventId(null);
                  }} style={styles.savedReminderCloseButton}>
                    <Text style={styles.savedReminderCloseText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        );
      })() : null;

  const confirmDeleteModal = confirmDeleteReminder ? (
    <Modal transparent visible={Boolean(confirmDeleteReminder)} animationType="fade" onRequestClose={() => setConfirmDeleteReminder(null)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, styles.confirmDeleteCard]}>
          <Text style={styles.confirmDeleteTitle}>{confirmDeleteReminder.target === 'event' ? 'Delete event?' : confirmDeleteReminder.target === 'all-reminders' ? 'Delete all reminders?' : 'Delete reminder?'}</Text>
          <Text style={styles.confirmDeleteText}>This action cannot be undone.</Text>

          <View style={styles.confirmDeleteActionRow}>
            <TouchableOpacity style={styles.confirmDeleteCancelButton} onPress={() => setConfirmDeleteReminder(null)}>
              <Text style={styles.confirmDeleteCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmDeleteDeleteButton}
              onPress={async () => {
                try {
                  if (confirmDeleteReminder.target === 'event') {
                    await deleteReminderEvent(confirmDeleteReminder.eventId);
                  } else if (confirmDeleteReminder.target === 'all-reminders') {
                    await deleteAllRemindersForEvent(confirmDeleteReminder.eventId);
                  } else if (confirmDeleteReminder.reminderEntryId) {
                    await deleteReminderEntry(confirmDeleteReminder.eventId, confirmDeleteReminder.reminderEntryId);
                  } else {
                    await deleteAllRemindersForEvent(confirmDeleteReminder.eventId);
                  }
                } finally {
                  setConfirmDeleteReminder(null);
                  setRemindersForEventId(null);
                }
              }}
            >
              <Text style={styles.confirmDeleteDeleteButtonText}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  ) : null;

  const voiceEventModal = (
    <Modal transparent visible={isVoiceEventModalVisible} animationType="fade" onRequestClose={closeVoiceEventModal}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.savedEventDetailsTitle}>Create by voice</Text>
          <Text style={styles.helperText}>
            Describe the event you want to schedule — what it is, who it's for, and when and where it's happening.
            Whatever you don't mention can be filled in afterward.
          </Text>

          <TextInput
            placeholderTextColor={colors.textPlaceholder}
            style={[styles.input, styles.notesInput, styles.voiceTranscriptInput]}
            multiline
            value={voiceTranscriptDraft}
            onChangeText={setVoiceTranscriptDraft}
            placeholder="Tap the microphone and start talking, or type here…"
          />

          <TouchableOpacity
            style={[styles.voiceRecordButton, isVoiceRecording && styles.voiceRecordButtonActive]}
            onPress={() => {
              if (isVoiceRecording) {
                stopVoiceRecording();
              } else {
                void startVoiceRecording();
              }
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.voiceRecordButtonText}>
              {isVoiceRecording ? '⏹ Stop recording' : '🎤 Start recording'}
            </Text>
          </TouchableOpacity>

          <View style={styles.savedEventDetailsActionRow}>
            <TouchableOpacity
              style={styles.savedEventDetailActionPill}
              onPress={closeVoiceEventModal}
              disabled={isParsingVoiceEvent}
            >
              <Text style={styles.savedEventDetailActionText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.savedEventDetailActionPill}
              onPress={() => void submitVoiceEventText()}
              disabled={isParsingVoiceEvent}
            >
              <Text style={styles.savedEventDetailActionText}>{isParsingVoiceEvent ? 'Understanding…' : 'Use This'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const rsvpDatePickerModal = (
    <Modal transparent visible={isRsvpDatePickerVisible} animationType="fade" onRequestClose={closeRsvpDatePicker}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.savedEventDetailsTitle}>RSVP by date</Text>
          <Text style={styles.helperText}>Choose the date by which guests should respond.</Text>

          {sharingEvent ? (
            <View style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(sharingEvent) }]}>
              {renderEventSummaryIcon(sharingEvent)}
              <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
                {formatEventDateOnly(sharingEvent)} ({formatEventCountdownLabel(sharingEvent)}) • {sharingEvent.title} • {sharingEvent.people}{formatEventSummaryRowTimeSuffix(sharingEvent)}
              </Text>
            </View>
          ) : null}

          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setRsvpPickerMonth(new Date(rsvpPickerMonth.getFullYear(), rsvpPickerMonth.getMonth() - 1, 1))}>
              <Text style={styles.modalNav}>◀</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{rsvpPickerMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
            <TouchableOpacity onPress={() => setRsvpPickerMonth(new Date(rsvpPickerMonth.getFullYear(), rsvpPickerMonth.getMonth() + 1, 1))}>
              <Text style={styles.modalNav}>▶</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <Text key={day} style={styles.weekDay}>{day}</Text>
            ))}
          </View>

          <View style={styles.calendarGrid}>
            {getCalendarDays(rsvpPickerMonth).map((day, index) => {
              if (!day) {
                return <View key={`empty-${index}`} style={styles.dayCell} />;
              }

              const isSelected = day.toDateString() === rsvpByDateDraft.toDateString();
              const isToday = day.toDateString() === new Date().toDateString();

              return (
                <TouchableOpacity
                  key={day.toISOString()}
                  style={[styles.dayCell, isSelected && styles.selectedDayCell]}
                  onPress={() => selectRsvpByDate(day.getDate())}
                >
                  <Text style={[styles.dayText, isToday && styles.todayText, isSelected && styles.selectedDayText]}>
                    {day.getDate()}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.savedEventDetailsActionRow}>
            <TouchableOpacity
              style={styles.savedEventDetailActionPill}
              onPress={closeRsvpDatePicker}
              disabled={isConfirmingRsvpByDate}
            >
              <Text style={styles.savedEventDetailActionText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.savedEventDetailActionPill}
              onPress={() => void confirmRsvpByDate()}
              disabled={isConfirmingRsvpByDate}
            >
              <Text style={styles.savedEventDetailActionText}>{isConfirmingRsvpByDate ? 'Confirming…' : 'Confirm'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const rsvpManagerEvent = rsvpManagerEventId ? events.find((event) => event.id === rsvpManagerEventId) : null;
  const rsvpManagerSummary = rsvpManagerEventId ? rsvpSummaries[rsvpManagerEventId] : null;

  const renderRsvpGuestRow = (
    entry: { id: string; firstName?: string; lastName?: string; label?: string; email?: string | null; phone?: string | null; message?: string | null },
    showRemind: boolean,
  ) => {
    const name = entry.label || [entry.firstName, entry.lastName].filter(Boolean).join(' ') || 'Guest';
    return (
      <View key={entry.id} style={styles.reminderListItem}>
        <View style={{ flex: 1 }}>
          <Text style={styles.reminderListDate}>{name}</Text>
          {entry.email ? <Text style={styles.reminderListNotes}>{entry.email}</Text> : null}
          {entry.phone ? <Text style={styles.reminderListNotes}>{entry.phone}</Text> : null}
          {entry.message ? <Text style={styles.reminderListNotes}>“{entry.message}”</Text> : null}
        </View>
        {showRemind && rsvpManagerEventId ? (
          <TouchableOpacity
            onPress={() => void remindRsvpInvite(rsvpManagerEventId, entry.id)}
            disabled={sendingRsvpReminderId === entry.id}
          >
            <Text style={styles.pendingReminderRemove}>{sendingRsvpReminderId === entry.id ? 'Sending…' : 'Remind'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  const rsvpManagerModal = rsvpManagerEvent ? (
    <Modal transparent visible={Boolean(rsvpManagerEventId)} animationType="fade" onRequestClose={() => setRsvpManagerEventId(null)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, styles.savedEventDetailsCard]}>
          <Text style={styles.savedEventDetailsTitle}>RSVPs • {rsvpManagerEvent.title}</Text>

          <View style={[styles.summaryLink, styles.summaryLinkColored, { backgroundColor: getEventSummaryColor(rsvpManagerEvent) }]}>
            {renderEventSummaryIcon(rsvpManagerEvent)}
            <Text style={[styles.summaryLinkText, styles.summaryLinkTextWrap, styles.summaryLinkTextColored]}>
              {formatEventDateOnly(rsvpManagerEvent)} ({formatEventCountdownLabel(rsvpManagerEvent)}) • {rsvpManagerEvent.title} • {rsvpManagerEvent.people}{formatEventSummaryRowTimeSuffix(rsvpManagerEvent)}
            </Text>
          </View>

          <ScrollView style={{ maxHeight: 380 }}>
            <Text style={styles.label}>Yes ({rsvpManagerSummary?.yes.length ?? 0})</Text>
            {rsvpManagerSummary?.yes.length ? (
              rsvpManagerSummary.yes.map((entry) => renderRsvpGuestRow(entry, false))
            ) : (
              <Text style={styles.helperText}>No Yes responses yet.</Text>
            )}

            <Text style={[styles.label, { marginTop: 12 }]}>No ({rsvpManagerSummary?.no.length ?? 0})</Text>
            {rsvpManagerSummary?.no.length ? (
              rsvpManagerSummary.no.map((entry) => renderRsvpGuestRow(entry, false))
            ) : (
              <Text style={styles.helperText}>No decline responses yet.</Text>
            )}

            <Text style={[styles.label, { marginTop: 12 }]}>No Reply ({rsvpManagerSummary?.noReply.length ?? 0})</Text>
            {rsvpManagerSummary?.noReply.length ? (
              rsvpManagerSummary.noReply.map((entry) => renderRsvpGuestRow(entry, true))
            ) : (
              <Text style={styles.helperText}>Everyone invited has responded.</Text>
            )}
          </ScrollView>

          <TouchableOpacity style={styles.savedEventDetailActionPill} onPress={() => setRsvpManagerEventId(null)}>
            <Text style={styles.savedEventDetailActionText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  ) : null;

  const rsvpGroupPromptModal = pendingRsvpGroupPrompt ? (
    <Modal transparent visible={Boolean(pendingRsvpGroupPrompt)} animationType="fade" onRequestClose={() => setPendingRsvpGroupPrompt(null)}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.savedEventDetailsTitle}>Keep the "{pendingRsvpGroupPrompt.groupName}" group?</Text>
          <Text style={styles.helperText}>
            This event had a contacts group created for its RSVPs. Deleting the event doesn't delete the group automatically — choose what to do with it.
          </Text>

          <TouchableOpacity
            style={[styles.floatingActionButton, styles.floatingActionPrimaryButton, { marginTop: 14 }]}
            onPress={() => setPendingRsvpGroupPrompt(null)}
            activeOpacity={0.8}
          >
            <Text style={styles.floatingActionPrimaryText}>Keep</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.floatingActionButton, styles.floatingActionSecondaryButton, { marginTop: 10 }]}
            onPress={() => {
              const groupId = pendingRsvpGroupPrompt.groupId;
              setPendingRsvpGroupPrompt(null);
              onRequestGroupRename?.(groupId);
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.floatingActionSecondaryText}>Rename</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.floatingActionButton, styles.savedEventDetailActionPillDanger, { marginTop: 10 }]}
            onPress={() => {
              const groupId = pendingRsvpGroupPrompt.groupId;
              setPendingRsvpGroupPrompt(null);
              void deleteRsvpGroup(groupId);
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.savedEventDetailActionTextDanger}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  ) : null;

  return (
    <>
      {currentView === 'share' ? renderShareView() : currentView === 'manage-events' ? renderManageEventsView() : currentView === 'manage-reminders' ? renderManageRemindersView() : renderCreateView()}
      {activeEventSummaryModal}
      {reminderEventModal}
      {confirmDeleteModal}
      {voiceEventModal}
      {rsvpDatePickerModal}
      {rsvpManagerModal}
      {rsvpGroupPromptModal}
      <TimePickerModal
        visible={activeTimePicker !== null}
        title={activeTimePicker?.title || 'Pick time'}
        initialDate={timePickerDraftDate}
        minuteInterval={activeClockIntervalMinutes}
        saveLabel="Save"
        onCancel={closeTimePicker}
        onSave={handleSaveTimePicker}
      />
      <Modal transparent visible={activeReminder !== null} animationType="fade" onRequestClose={() => {
        setActiveReminder(null);
        restoreInterruptedModalContext();
      }}>
        <View style={styles.modalOverlay}>
          <View style={styles.activeReminderCard}>
            <Text style={styles.activeReminderTitle}>Calendar Reminder</Text>
            {activeReminderEntry ? (
              <>
                <Text style={styles.activeReminderEventTitle} numberOfLines={2}>{activeReminderEntry.event.title}</Text>
                <Text style={styles.activeReminderEventDetails} numberOfLines={2}>{activeReminderEntry.event.people}</Text>
                <Text style={styles.activeReminderEventDetails}>{formatActiveReminderWhen(activeReminderEntry.event)}</Text>
              </>
            ) : (
              <Text style={styles.activeReminderEventDetails}>There are no active reminders for this event.</Text>
            )}
            <View style={styles.activeReminderActions}>
              <TouchableOpacity style={styles.activeReminderActionButton} onPress={handleViewActiveReminder}>
                <Text style={styles.activeReminderActionText}>View</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.activeReminderActionButton} onPress={() => {
                setActiveReminder(null);
                restoreInterruptedModalContext();
              }}>
                <Text style={styles.activeReminderActionText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const createAppContentStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    padding: 24,
    paddingBottom: 40,
    backgroundColor: colors.surfaceTint,
  },
  manageEventsScreen: {
    flex: 1,
    position: 'relative',
  },
  manageEventsScroll: {
    flex: 1,
  },
  manageEventsScrollContentWithFooter: {
    paddingBottom: 76,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 16,
  },
  helperText: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },
  landingTickerSection: {
    marginTop: 8,
    marginBottom: 6,
  },
  landingTickerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  landingTickerWrap: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceTint,
    borderWidth: 1,
    borderColor: colors.borderTint,
    borderRadius: 10,
    height: 28,
    justifyContent: 'center',
  },
  landingTickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 10,
    width: 2000,
  },
  landingTickerText: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    position: 'relative',
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  shareCard: {
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  shareEventDetailsCard: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    backgroundColor: colors.background,
  },
  preferenceToggleText: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  shareOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  shareRadioOuter: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  shareRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  shareActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  shareBuilderCard: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    backgroundColor: colors.background,
  },
  shareRecipientPickerRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  shareRecipientPickerWrapper: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  shareRecipientInlineInput: {
    flex: 1,
    marginBottom: 0,
    backgroundColor: colors.surface,
  },
  shareRecipientAddButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareRecipientAddButtonDisabled: {
    backgroundColor: colors.textPlaceholder,
  },
  shareRecipientList: {
    gap: 8,
  },
  shareRecipientCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 10,
    backgroundColor: colors.surface,
  },
  shareActionButton: {
    flex: 1,
    marginBottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 8,
    color: colors.textPrimary,
  },
  inlineSelectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  eventTypeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  voiceMicButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  voiceMicButtonIcon: {
    fontSize: 22,
  },
  inlineSelectionValueButton: {
    paddingVertical: 4,
  },
  inlineSelectionValueText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  inlineSelectionConfirmButton: {
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  dropdownDismissBackdrop: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
  },
  dropdownList: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    zIndex: 20,
  },
  dropdownListItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dropdownListItemSelected: {
    backgroundColor: colors.surfaceTint,
  },
  dropdownListItemText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },
  dropdownListItemTextSelected: {
    color: colors.primaryPressed,
    fontWeight: '700',
  },
  filterPillList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
    position: 'relative',
    zIndex: 20,
    elevation: 20,
  },
  filterPillListSpaced: {
    marginTop: 10,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterPillNeutral: {
    backgroundColor: colors.surfaceSubtle,
  },
  filterPillAll: {
    backgroundColor: '#000000',
  },
  filterPillTextOnBlack: {
    color: '#ffffff',
  },
  filterPillSelected: {
    borderColor: colors.textPrimary,
  },
  filterPillIcon: {
    fontSize: 14,
    marginRight: 4,
  },
  filterPillText: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterPillTextColored: {
    color: colors.onColor,
  },
  filterPillTextNeutral: {
    color: colors.textPrimary,
  },
  savedEventsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
    flexWrap: 'wrap',
  },
  savedSectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.border,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  refreshButtonText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
  },
  toggleButton: {
    backgroundColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 112,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleButtonActive: {
    backgroundColor: colors.borderTint,
  },
  toggleButtonText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  toggleButtonIcon: {
    fontSize: 20,
    textAlign: 'center',
  },
  createEventPlusIcon: {
    color: colors.textPrimary,
    fontWeight: '800',
  },
  viewControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  viewControlsRowCentered: {
    justifyContent: 'center',
  },
  viewControlsCompactButton: {
    width: 104,
    minWidth: 0,
    paddingHorizontal: 8,
  },
  filterLinkButton: {
    paddingVertical: 4,
  },
  filterLinkText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  filterLinkTextActive: {
    color: colors.primary,
  },
  savedEventsFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'nowrap',
    marginTop: 16,
  },
  viewLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  viewControlsGroup: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  savedEventAddressBlock: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 8,
    backgroundColor: colors.background,
    alignSelf: 'stretch',
    alignItems: 'stretch',
    width: '100%',
  },
  savedEventAddressLine: {
    color: colors.textPrimary,
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'left',
    alignSelf: 'stretch',
  },
  calendarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    color: colors.textPrimary,
  },
  shareContactSearchInput: {
    margin: 10,
    marginBottom: 6,
  },
  validationBanner: {
    backgroundColor: colors.dangerBg,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  validationBannerText: {
    color: colors.dangerPressed,
    fontWeight: '600',
  },
  apiStatusBanner: {
    backgroundColor: colors.warningBg,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  apiStatusBannerText: {
    color: colors.warningText,
    fontWeight: '600',
  },
  pickerWrapper: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
  },
  eventLocationToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  shareRsvpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    marginBottom: 8,
  },
  shareRsvpToggle: {
    marginBottom: 0,
  },
  eventLocationRadioOuter: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  eventLocationRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  eventLocationToggleText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },
  eventLocationSuggestionsList: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    backgroundColor: colors.surface,
    marginBottom: 8,
    overflow: 'hidden',
  },
  eventLocationSuggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  eventLocationSuggestionMainText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  eventLocationSuggestionSecondaryText: {
    color: colors.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  eventLocationCityStateZipRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  eventLocationStatePickerWrapper: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  eventLocationStateInput: {
    flex: 0.62,
  },
  eventLocationZipInput: {
    flex: 0.38,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 4,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  checkboxUnchecked: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  checkboxLabel: {
    color: colors.textPrimary,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  eventTimeGroupsRow: {
    flexDirection: 'column',
    gap: 12,
    alignItems: 'stretch',
    marginBottom: 8,
  },
  eventTimeGroup: {
    width: '100%',
  },
  timeValueButton: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    backgroundColor: colors.background,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  timeValueButtonText: {
    color: colors.primaryPressed,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  variableReminderLayout: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  variableReminderCalendarCard: {
    flex: 1.2,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 10,
    backgroundColor: colors.surface,
  },
  variableReminderClockCard: {
    flex: 0.8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 9,
    backgroundColor: colors.surface,
  },
  variableReminderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  variableReminderMonthYearWrap: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  variableReminderYear: {
    fontSize: 11,
    lineHeight: 14,
    color: colors.textTertiary,
    fontWeight: '600',
  },
  variableReminderMonth: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  variableReminderNav: {
    fontSize: 18,
    color: colors.primary,
    paddingHorizontal: 8,
  },
  picker: {
    color: colors.textPrimary,
  },
  notesInput: {
    minHeight: 70,
    textAlignVertical: 'top',
  },
  voiceTranscriptInput: {
    minHeight: 110,
    marginTop: 12,
    marginBottom: 12,
  },
  voiceRecordButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    marginBottom: 12,
  },
  voiceRecordButtonActive: {
    backgroundColor: colors.dangerBg,
  },
  voiceRecordButtonText: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  reminderModeRow: {
    flexWrap: 'nowrap',
  },
  reminderModeScrollContainer: {
    marginBottom: 8,
    overflow: 'visible',
  },
  reminderModeScrollContent: {
    paddingHorizontal: 8,
    paddingRight: 24,
    alignItems: 'center',
    gap: 10,
  },
  reminderModeScrollButton: {
    minWidth: 120,
    height: 52,
    paddingHorizontal: 18,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  reminderModeScrollButtonSelected: {
    backgroundColor: colors.primary,
  },
  reminderModeScrollButtonUnselected: {
    backgroundColor: colors.border,
  },
  reminderModeScrollButtonText: {
    fontSize: 15,
    fontWeight: '700',
    textTransform: 'capitalize',
    textAlign: 'center',
  },
  reminderModeScrollButtonTextSelected: {
    color: colors.onColor,
  },
  reminderModeScrollButtonTextUnselected: {
    color: colors.textSecondary,
  },
  reminderFrequencyScrollContainer: {
    marginBottom: 8,
    overflow: 'visible',
  },
  frequencyOption: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 6,
    marginBottom: 6,
  },
  reminderModeOption: {
    flex: 1,
    marginRight: 0,
    alignItems: 'center',
    paddingHorizontal: Platform.OS === 'ios' ? 8 : 12,
  },
  frequencyOptionSelected: {
    backgroundColor: colors.primary,
  },
  frequencyOptionUnselected: {
    backgroundColor: colors.border,
  },
  frequencyOptionText: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  reminderModeOptionText: {
    fontSize: Platform.OS === 'ios' ? 12 : 13,
  },
  frequencyOptionTextSelected: {
    color: colors.onColor,
  },
  frequencyOptionTextUnselected: {
    color: colors.textSecondary,
  },
  floatingActionStripWrap: {
    marginTop: 12,
    marginBottom: 4,
    paddingVertical: 6,
    overflow: 'visible',
  },
  floatingActionStripContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingRight: 28,
    alignItems: 'center',
    gap: 12,
  },
  floatingActionButton: {
    minWidth: 150,
    height: 54,
    borderRadius: 16,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  noRemindersButton: {
    overflow: 'hidden',
    position: 'relative',
  },
  noRemindersGradientBands: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  noRemindersGradientBand: {
    flex: 1,
  },
  floatingActionPrimaryButton: {
    backgroundColor: colors.primary,
  },
  floatingActionSecondaryButton: {
    backgroundColor: colors.border,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  floatingActionPrimaryText: {
    color: colors.onColor,
    fontWeight: '800',
    fontSize: 15,
    textAlign: 'center',
  },
  floatingActionSecondaryText: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 15,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 6,
  },
  primaryButtonText: {
    color: colors.onColor,
    fontWeight: '700',
  },
  addReminderButtonText: {
    color: colors.onColor,
    fontWeight: '700',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
  reminderActionHint: {
    fontSize: 12,
    color: colors.textTertiary,
    marginBottom: 6,
    width: '100%',
    alignSelf: 'stretch',
    flexShrink: 1,
    flexWrap: 'wrap',
    lineHeight: 16,
  },
  deleteAllRemindersButton: {
    backgroundColor: colors.dangerText,
    alignSelf: 'stretch',
  },
  deleteAllRemindersButtonText: {
    textAlign: 'center',
  },
  pendingReminderCard: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pendingReminderText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  pendingReminderSubtext: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },
  pendingReminderRemove: {
    color: colors.dangerText,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 760,
    minWidth: 320,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  savedEventDetailsCard: {
    maxWidth: 680,
    paddingHorizontal: 18,
    paddingVertical: 20,
  },
  savedEventDetailsTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 8,
    textAlign: 'left',
  },
  savedEventDetailsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginBottom: 0,
  },
  savedEventDetailsEventTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  savedEventDetailsMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: 14,
    rowGap: 4,
    marginBottom: 8,
  },
  savedEventDetailsReminderCounter: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '700',
    color: colors.primary,
  },
  savedEventDetailsPeople: {
    fontSize: 16,
    lineHeight: 16,
    color: colors.textPrimary,
    marginBottom: 0,
  },
  savedEventDetailsMeta: {
    fontSize: 15,
    lineHeight: 15,
    color: colors.textPrimary,
    marginBottom: 0,
  },
  savedEventDetailsLocationBlock: {
    marginTop: 6,
    gap: 2,
  },
  savedEventDetailsActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'nowrap',
    gap: 12,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  summaryPaginationRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: colors.surfaceTint,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  summaryPagerButton: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: colors.surfaceSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  summaryPagerButtonDisabled: {
    backgroundColor: colors.background,
  },
  summaryPagerButtonText: {
    color: colors.dangerPressed,
    fontSize: 14,
    fontWeight: '700',
  },
  summaryPagerPageText: {
    flexShrink: 0,
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    minWidth: 92,
  },
  savedEventDetailsActionLabel: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginRight: 4,
  },
  savedEventDetailActionPill: {
    borderRadius: 999,
    backgroundColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 18,
    minWidth: 104,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedEventDetailActionPillDanger: {
    borderRadius: 999,
    backgroundColor: colors.dangerBg,
    paddingVertical: 12,
    paddingHorizontal: 18,
    minWidth: 104,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedEventDetailActionText: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  savedEventDetailActionTextDanger: {
    color: colors.dangerPressed,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  savedReminderCloseButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceTint,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignSelf: 'center',
    minWidth: 120,
  },
  savedReminderCloseText: {
    color: colors.primary,
    fontSize: 20,
    fontWeight: '700',
  },
  savedReminderItemCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    backgroundColor: colors.background,
  },
  savedReminderItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  savedReminderItemTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
    lineHeight: 18,
  },
  savedReminderItemSubtext: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  savedReminderDeleteButton: {
    backgroundColor: colors.dangerBg,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 136,
  },
  savedReminderDeleteButtonText: {
    color: colors.dangerPressed,
    fontWeight: '700',
    fontSize: 13,
  },
  savedReminderActionsWrap: {
    marginTop: 12,
    gap: 10,
  },
  savedReminderPrimaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    width: '100%',
  },
  savedReminderPrimaryButtonText: {
    color: colors.onColor,
    fontSize: 18,
    fontWeight: '800',
  },
  savedReminderDangerButton: {
    backgroundColor: colors.dangerText,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    width: '100%',
  },
  savedReminderDangerButtonText: {
    color: colors.onColor,
    fontSize: 18,
    fontWeight: '800',
  },
  confirmDeleteCard: {
    maxWidth: 440,
    paddingHorizontal: 18,
    paddingVertical: 20,
  },
  confirmDeleteTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  confirmDeleteText: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 12,
  },
  confirmDeleteActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  confirmDeleteCancelButton: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: colors.border,
    paddingVertical: 12,
    alignItems: 'center',
  },
  confirmDeleteCancelText: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  confirmDeleteDeleteButton: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: colors.dangerText,
    paddingVertical: 12,
    alignItems: 'center',
  },
  confirmDeleteDeleteButtonText: {
    color: colors.onColor,
    fontWeight: '700',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    color: colors.textPrimary,
  },
  activeReminderCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 0,
    paddingTop: 14,
    paddingBottom: 6,
    overflow: 'hidden',
  },
  activeReminderTitle: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  activeReminderEventTitle: {
    fontSize: 22,
    fontWeight: '500',
    textAlign: 'center',
    color: colors.textPrimary,
    marginHorizontal: 16,
  },
  activeReminderEventDetails: {
    fontSize: 16,
    textAlign: 'center',
    color: colors.textPrimary,
    marginHorizontal: 16,
    marginTop: 2,
  },
  activeReminderActions: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  activeReminderActionButton: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'center',
  },
  activeReminderActionText: {
    color: colors.primaryPressed,
    fontSize: 18,
    fontWeight: '500',
  },
  modalBody: {
    fontSize: 15,
    color: colors.textPrimary,
  },
  shareInviteBodyText: {
    textAlign: 'center',
    alignSelf: 'center',
    width: '100%',
  },
  shareInviteDetailText: {
    textAlign: 'center',
    alignSelf: 'center',
    width: '100%',
  },
  shareInviteActionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  shareInviteActionButton: {
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 0,
  },
  confirmActionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 8,
  },
  confirmActionSide: {
    flex: 1,
    justifyContent: 'center',
  },
  confirmActionDivider: {
    width: 1,
    backgroundColor: colors.borderStrong,
    marginHorizontal: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalNav: {
    fontSize: 20,
    color: colors.primary,
    paddingHorizontal: 8,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  weekDay: {
    width: '14%',
    textAlign: 'center',
    color: colors.textTertiary,
    fontSize: 12,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  calendarViewCard: {
    position: 'relative',
    overflow: 'hidden',
  },
  calendarDateBelowPanel: {
    marginTop: 12,
    gap: 4,
  },
  calendarDateDetailCard: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
    marginBottom: 12,
  },
  calendarDateDetailCardSpaced: {
    marginTop: 8,
  },
  dayCell: {
    width: '14%',
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
    borderRadius: 999,
  },
  dayCellWithEvents: {
    borderWidth: 1,
    borderColor: colors.primarySoft,
    backgroundColor: colors.surfaceTint,
  },
  dayCellWithReminder: {
    borderWidth: 1,
    borderColor: colors.dangerText,
    backgroundColor: colors.dangerBg,
  },
  dayCellHolidayDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.warning,
    marginTop: 2,
  },
  selectedDayCell: {
    backgroundColor: colors.primary,
  },
  todayDayCell: {
    backgroundColor: colors.warning,
    borderWidth: 0,
  },
  todayDayCellText: {
    color: colors.onColor,
    fontWeight: '700',
  },
  dayText: {
    color: colors.textPrimary,
  },
  todayText: {
    fontWeight: '700',
    color: colors.primary,
  },
  selectedDayText: {
    color: colors.onColor,
    fontWeight: '700',
  },
  nextReminder: {
    fontSize: 16,
    color: colors.primaryPressed,
  },
  eventRow: {
    paddingVertical: 10,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  eventContentRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  eventDetails: {
    width: '100%',
  },
  eventTitle: {
    fontWeight: '700',
  },
  summaryLink: {
    paddingVertical: 6,
  },
  summaryLinkColored: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 4,
  },
  summaryLinkText: {
    color: colors.primary,
    fontWeight: '600',
    textDecorationLine: 'underline',
    flexShrink: 1,
  },
  summaryLinkTextWrap: {
    flex: 1,
    lineHeight: 18,
  },
  summaryLinkTextColored: {
    color: colors.onColor,
    textDecorationLine: 'none',
  },
  summaryLinkIcon: {
    fontSize: 24,
    marginRight: 8,
  },
  summaryLinkPhoto: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 8,
  },
  reminderCountLink: {
    color: colors.primary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  reminderCountLinkDisabled: {
    color: colors.textTertiary,
    textDecorationLine: 'none',
  },
  notesText: {
    color: colors.textTertiary,
    fontSize: 13,
    marginTop: 4,
  },
  frequency: {
    color: colors.accentTeal,
    marginTop: 2,
  },
  noActiveReminderText: {
    color: colors.dangerText,
    fontWeight: '700',
  },
  actionColumn: {
    alignItems: 'flex-end',
    gap: 6,
    marginTop: 8,
  },
  actionButton: {
    backgroundColor: colors.border,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
    minWidth: 74,
    alignItems: 'center',
  },
  actionButtonText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: 12,
  },
  actionButtonDisabled: {
    backgroundColor: colors.borderStrong,
    opacity: 0.7,
  },
  reminderListItem: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  reminderListRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  reminderListDate: {
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1,
    flexWrap: 'nowrap',
  },
  reminderListNotes: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
    flexShrink: 1,
    flexWrap: 'nowrap',
    maxWidth: '100%',
    overflow: 'hidden',
  },
  reminderDeleteButton: {
    backgroundColor: colors.dangerBg,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  reminderDeleteButtonText: {
    color: colors.dangerPressed,
    fontSize: 12,
    fontWeight: '600',
  },
});
