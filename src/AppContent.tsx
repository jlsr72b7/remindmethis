import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
  Button,
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
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
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
  requestNotificationPermission,
  sendShareEmailNotification,
  sendReminderEmailNotification,
  sendReminderSmsNotification,
  subscribeApiStorageStatus,
  isApiStorageEnabled,
  validateEmail,
  validatePhoneNumber,
} from './storage';
import {
  clearScheduledReminders,
  getNotificationDiagnostics,
  playReminderPing,
  scheduleReminder,
} from './notifications';
import { getDeviceTimeZone } from './timeZones';
import TimePickerModal from './TimePickerModal';
import { EventLocationAddress, ReminderFrequency, SpecialDateEvent, VariableReminderEntry } from './types';

type EventTypeValue = 'birthday' | 'party' | 'wedding' | 'anniversary' | 'medical' | 'dental' | 'work' | 'school' | 'other';
type PartySubtypeValue = 'birthday' | 'anniversary' | 'retirement' | 'engagement' | 'holiday' | 'other';
type MedicalSubtypeValue = 'appointment' | 'surgery' | 'blood-work' | 'radiology' | 'rehab' | 'other';
type DentalSubtypeValue = 'cleaning' | 'extraction' | 'check-up' | 'root-canal' | 'bridge' | 'dentures' | 'cavities' | 'implants' | 'crown' | 'fitting' | 'other';
type WorkSubtypeValue = 'meeting' | 'review' | 'conference' | 'demo' | 'workshop' | 'presentation' | 'interview' | 'other';
type SchoolSubtypeValue = 'quiz' | 'test' | 'paper-due' | 'project-due' | 'class-presentation' | 'other';
type ReminderModeValue = 'none' | 'default' | 'static' | 'variable';
type TimePickerTarget = 'event-start' | 'event-end' | 'static-reminder' | 'pending-reminder';

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

const getSubtypeDisplayLabel = (form: ReturnType<typeof getResetFormState>) => {
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
  form: ReturnType<typeof getResetFormState>,
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

const createDefaultForm = (reminderTimeZone: string) => {
  const defaultEventDateTime = getDefaultDate();
  return {
    eventType: 'birthday' as EventTypeValue,
    partySubtype: 'birthday' as PartySubtypeValue,
    medicalSubtype: 'appointment' as MedicalSubtypeValue,
    dentalSubtype: 'cleaning' as DentalSubtypeValue,
    workSubtype: 'meeting' as WorkSubtypeValue,
    schoolSubtype: 'quiz' as SchoolSubtypeValue,
    shareAfterSave: false,
    eventLocationEnabled: false,
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
    reminderDateTime: new Date(defaultEventDateTime),
    reminderAllDay: false,
    reminderTimeZone,
  };
};

const getResetFormState = (reminderTimeZone: string) => {
  const now = new Date();
  now.setSeconds(0, 0, 0);
  return {
    ...createDefaultForm(reminderTimeZone),
    eventDateTime: new Date(now),
    eventEndDateTime: getDefaultEndDate(new Date(now)),
    reminderDateTime: new Date(now),
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

  const line1 = form.eventLocationLine1.trim();
  const line2 = form.eventLocationLine2.trim();
  const city = form.eventLocationCity.trim();
  const state = normalizeStateCode(form.eventLocationState);
  const zip = normalizeZipCode(form.eventLocationZip);
  const phone = formatPhoneNumberInput(form.eventLocationPhone.trim());
  const placeId = form.eventLocationPlaceId.trim();
  const formattedAddress = form.eventLocationFormattedAddress.trim();

  if (!line1 && !line2 && !city && !state && !zip && !formattedAddress && !phone) {
    return undefined;
  }

  return {
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
  const digits = value.replace(/\D/g, '').slice(0, 10);

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

const openExternalComposer = async (url: string) => {
  const isMailOrSmsUrl = /^mailto:|^sms:/i.test(url);

  if (Platform.OS === 'web') {
    // VS Code's embedded browser can navigate to raw mailto/sms URLs and appear blank.
    // Return false so caller can use a fallback instead of hanging the app page.
    if (isMailOrSmsUrl) {
      return false;
    }

    const openFn = (globalThis as { open?: (url?: string, target?: string, features?: string) => Window | null }).open;
    if (typeof openFn === 'function') {
      const opened = openFn(url, '_blank', 'noopener,noreferrer');
      return Boolean(opened);
    }
  }

  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    return false;
  }

  await Linking.openURL(url);
  return true;
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
) => {
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

  const reminders = reminderSpecs
    .map((spec) => {
      const reminderDateTime = createReminderDate(spec.kind);
      return reminderDateTime.getTime() >= now ? {
        id: `default-${spec.idPrefix}-${reminderDateTime.getTime()}`,
        title: title || 'Reminder',
        people: people || 'You',
        eventDateTime: sourceDate.toISOString(),
        reminderDateTime: reminderDateTime.toISOString(),
        eventAllDay: false,
        reminderAllDay: false,
        frequency: 'once' as ReminderFrequency,
        notes,
        notified: false,
      } : null;
    })
    .filter((item): item is SpecialDateEvent => item !== null);

  return reminders.sort((left, right) => new Date(left.reminderDateTime).getTime() - new Date(right.reminderDateTime).getTime());
};

const getEventFormState = (event: SpecialDateEvent) => {
  const normalizedTitle = event.title.toLowerCase().trim();
  const eventLocation = event.eventLocation;
  const hasEventLocation = Boolean(
    eventLocation
    && (
      eventLocation.line1
      || eventLocation.line2
      || eventLocation.city
      || eventLocation.state
      || eventLocation.zip
      || eventLocation.formattedAddress
      || eventLocation.phone
    ),
  );

  const baseState = {
    partySubtype: 'birthday' as PartySubtypeValue,
    medicalSubtype: 'appointment' as MedicalSubtypeValue,
    dentalSubtype: 'cleaning' as DentalSubtypeValue,
    workSubtype: 'meeting' as WorkSubtypeValue,
    shareAfterSave: false,
    eventLocationEnabled: hasEventLocation,
    eventLocationPlaceId: eventLocation?.placeId || '',
    eventLocationFormattedAddress: eventLocation?.formattedAddress || '',
    eventLocationLine1: eventLocation?.line1 || '',
    eventLocationLine2: eventLocation?.line2 || '',
    eventLocationCity: eventLocation?.city || '',
    eventLocationState: normalizeStateCode(eventLocation?.state || ''),
    eventLocationZip: eventLocation?.zip || '',
    eventLocationPhone: formatPhoneNumberInput(eventLocation?.phone || ''),
    customType: '',
  };

  if (normalizedTitle === 'birthday') {
    return { eventType: 'birthday' as EventTypeValue, ...baseState };
  }

  if (normalizedTitle.endsWith(' party')) {
    const baseLabel = normalizedTitle.slice(0, -' party'.length);
    if (baseLabel === 'birthday') {
      return { eventType: 'party' as EventTypeValue, ...baseState, partySubtype: 'birthday' as PartySubtypeValue };
    }

    if (baseLabel === 'anniversary') {
      return { eventType: 'party' as EventTypeValue, ...baseState, partySubtype: 'anniversary' as PartySubtypeValue };
    }

    if (baseLabel === 'retirement') {
      return { eventType: 'party' as EventTypeValue, ...baseState, partySubtype: 'retirement' as PartySubtypeValue };
    }

    if (baseLabel === 'engagement') {
      return { eventType: 'party' as EventTypeValue, ...baseState, partySubtype: 'engagement' as PartySubtypeValue };
    }

    if (baseLabel === 'holiday') {
      return { eventType: 'party' as EventTypeValue, ...baseState, partySubtype: 'holiday' as PartySubtypeValue };
    }
  }

  if (normalizedTitle === 'doctors appointment' || normalizedTitle === 'medical appointment') {
    return { eventType: 'medical' as EventTypeValue, ...baseState, medicalSubtype: 'appointment' as MedicalSubtypeValue };
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
        eventType: 'medical' as EventTypeValue,
        ...baseState,
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
      eventType: 'medical' as EventTypeValue,
      ...baseState,
      medicalSubtype: standaloneMedicalSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'dental') {
    return { eventType: 'dental' as EventTypeValue, ...baseState, dentalSubtype: 'other' as DentalSubtypeValue };
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
        eventType: 'dental' as EventTypeValue,
        ...baseState,
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
      eventType: 'dental' as EventTypeValue,
      ...baseState,
      dentalSubtype: standaloneDentalSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'work') {
    return { eventType: 'work' as EventTypeValue, ...baseState, workSubtype: 'other' as WorkSubtypeValue };
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
        eventType: 'work' as EventTypeValue,
        ...baseState,
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
      eventType: 'work' as EventTypeValue,
      ...baseState,
      workSubtype: standaloneWorkSubtypeMap[normalizedTitle],
    };
  }

  if (normalizedTitle === 'wedding' || normalizedTitle === 'anniversary') {
    const eventTypeMap: Record<string, EventTypeValue> = {
      wedding: 'wedding',
      anniversary: 'anniversary',
    };

    return {
      eventType: eventTypeMap[normalizedTitle],
      ...baseState,
    };
  }

  return {
    eventType: 'other' as EventTypeValue,
    ...baseState,
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

  const line1 = eventLocation.line1.trim();
  const line2 = eventLocation.line2 ? eventLocation.line2.trim() : '';
  const city = eventLocation.city.trim();
  const state = getStateLabelFromCode(normalizeStateCode(eventLocation.state.trim()));
  const zip = eventLocation.zip.trim();
  const phone = eventLocation.phone ? formatPhoneNumberInput(eventLocation.phone.trim()) : '';
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').trim();
  const fallback = eventLocation.formattedAddress ? eventLocation.formattedAddress.trim() : '';
  const lines = [line1, line2, cityStateZip, phone ? `Phone: ${phone}` : ''].filter(Boolean);

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

const getReminderCandidates = (event: SpecialDateEvent) => {
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

  const candidatesByTime = new Map<number, typeof staticCandidate>();
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

interface AppContentProps {
  userId?: string;
  userEmail?: string;
  defaultReminderTimeZone?: string;
}

interface ShareContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mobileNumber?: string;
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

export default function AppContent({ userId, userEmail, defaultReminderTimeZone }: AppContentProps) {
  const apiStorageEnabled = isApiStorageEnabled();
  const effectiveReminderTimeZone = defaultReminderTimeZone || DEVICE_TIME_ZONE;
  const [events, setEvents] = useState<SpecialDateEvent[]>([]);
  const [hasLoadedInitialEvents, setHasLoadedInitialEvents] = useState(false);
  const [form, setForm] = useState(() => getResetFormState(effectiveReminderTimeZone));
  const [hasSelectedEventType, setHasSelectedEventType] = useState(false);
  const [isEventTypePickerVisible, setIsEventTypePickerVisible] = useState(true);
  const [eventTypeDraft, setEventTypeDraft] = useState<EventTypeValue | ''>('');
  const [hasSelectedSubtype, setHasSelectedSubtype] = useState(false);
  const [isSubtypePickerVisible, setIsSubtypePickerVisible] = useState(false);
  const [subtypeDraft, setSubtypeDraft] = useState('');
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
  const [currentView, setCurrentView] = useState<'landing' | 'create' | 'share'>('landing');
  const [viewVersion, setViewVersion] = useState(0);
  const [pendingVariableReminders, setPendingVariableReminders] = useState<SpecialDateEvent[]>([]);
  const [seededVariableDraftIds, setSeededVariableDraftIds] = useState<string[]>([]);
  const [pendingReminderDateTime, setPendingReminderDateTime] = useState<Date>(getDefaultDate());
  const [pendingReminderMonth, setPendingReminderMonth] = useState<Date>(getDefaultDate());
  const [staticReminderMonth, setStaticReminderMonth] = useState<Date>(getDefaultDate());
  const [hasTouchedStaticReminderSchedule, setHasTouchedStaticReminderSchedule] = useState(false);
  const [savedEventsView, setSavedEventsView] = useState<'list' | 'calendar' | 'summary'>('summary');
  const [savedRemindersView, setSavedRemindersView] = useState<'list' | 'calendar' | 'summary'>('summary');
  const [savedEventsSummaryPage, setSavedEventsSummaryPage] = useState(0);
  const [savedRemindersSummaryPage, setSavedRemindersSummaryPage] = useState(0);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date | null>(null);
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
  const [reminderDeliveryEmailEnabled, setReminderDeliveryEmailEnabled] = useState(false);
  const [reminderDeliveryTextEnabled, setReminderDeliveryTextEnabled] = useState(false);
  const [reminderSoundEnabled, setReminderSoundEnabled] = useState(true);
  const [defaultReminderTime, setDefaultReminderTime] = useState<ReminderDefaultTimeSettings>({ hour: 9, minute: 0, clockIntervalMinutes: 5 });
  const [sharingEvent, setSharingEvent] = useState<SpecialDateEvent | null>(null);
  const [shareContacts, setShareContacts] = useState<ShareContact[]>([]);
  const [shareGroups, setShareGroups] = useState<ShareGroup[]>([]);
  const [selectedShareContactId, setSelectedShareContactId] = useState('');
  const [selectedShareGroupId, setSelectedShareGroupId] = useState('');
  const [shareManualEmail, setShareManualEmail] = useState('');
  const [shareManualPhone, setShareManualPhone] = useState('');
  const [shareRecipients, setShareRecipients] = useState<ShareRecipient[]>([]);
  const [shareMessage, setShareMessage] = useState('');
  const [isSendingShare, setIsSendingShare] = useState(false);
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

  const shareSelectableContacts = useMemo(
    () => shareContacts.filter((contact) => !contact.deletedAt),
    [shareContacts],
  );
  const shareContactOptions = useMemo(
    () => shareSelectableContacts.map((contact) => ({
      label: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ''}`,
      value: contact.id,
    })),
    [shareSelectableContacts],
  );
  const shareGroupOptions = useMemo(
    () => shareGroups.map((group) => ({ label: group.name, value: group.id })),
    [shareGroups],
  );
  const activeClockIntervalMinutes = useMemo(
    () => normalizeClockIntervalMinutes(defaultReminderTime.clockIntervalMinutes),
    [defaultReminderTime.clockIntervalMinutes],
  );
  const [eventLocationPredictions, setEventLocationPredictions] = useState<GoogleAddressPrediction[]>([]);
  const [isEventLocationLine1Focused, setIsEventLocationLine1Focused] = useState(false);
  const [eventLocationAutocompleteSessionToken] = useState(() => `event-addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const skipNextEventLocationAutocompleteFetchRef = useRef(0);
  const eventLocationBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTypeSelectionUi = useCallback(() => {
    setHasSelectedEventType(false);
    setIsEventTypePickerVisible(true);
    setEventTypeDraft('');
    setHasSelectedSubtype(false);
    setIsSubtypePickerVisible(false);
    setSubtypeDraft('');
  }, []);

  useEffect(() => () => {
    if (eventLocationBlurTimeoutRef.current) {
      clearTimeout(eventLocationBlurTimeoutRef.current);
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
    if (currentView !== 'share' || !userId) {
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
      setSelectedShareContactId((current) => current || snapshot.contacts[0]?.id || '');
      setSelectedShareGroupId((current) => current || snapshot.groups[0]?.id || '');
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

  const addSelectedShareContact = useCallback(() => {
    const contact = shareSelectableContacts.find((entry) => entry.id === selectedShareContactId);
    if (!contact) {
      return;
    }

    appendShareRecipients([{
      key: `contact:${contact.id}`,
      label: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ''}`,
      email: contact.email || undefined,
      phone: contact.mobileNumber ? formatPhoneNumberInput(contact.mobileNumber) : undefined,
      source: 'contact',
    }]);
  }, [appendShareRecipients, selectedShareContactId, shareSelectableContacts]);

  const addSelectedShareGroup = useCallback(() => {
    const group = shareGroups.find((entry) => entry.id === selectedShareGroupId);
    if (!group) {
      return;
    }

    const groupRecipients = group.contactIds
      .map((contactId) => shareSelectableContacts.find((entry) => entry.id === contactId) || null)
      .filter((entry): entry is ShareContact => entry !== null)
      .map((contact) => ({
        key: `contact:${contact.id}`,
        label: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ''}`,
        email: contact.email || undefined,
        phone: contact.mobileNumber ? formatPhoneNumberInput(contact.mobileNumber) : undefined,
        source: 'group' as const,
      }));

    appendShareRecipients(groupRecipients);
  }, [appendShareRecipients, selectedShareGroupId, shareGroups, shareSelectableContacts]);

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
          const permissionGranted = await requestNotificationPermission();
          if (!permissionGranted) {
            setApiStorageStatusMessage('iOS notification permission is not enabled, so reminders will only appear inside the app until you allow notifications in Settings.');
          }
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
    if (currentView !== 'create' || hasInitializedReminderScheduleView || !isReminderTimeZoneMode(form.reminderMode)) {
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
    if (currentView !== 'create' || form.reminderMode !== 'default') {
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
    if (currentView !== 'create' || form.reminderMode !== 'static' || hasTouchedStaticReminderSchedule) {
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
          return new Date(candidate.reminderDateTime).getTime() <= now.getTime() && !candidate.entry.notified;
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
      return;
    }

    const sourceReminderDate = form.reminderMode === 'static' ? form.reminderDateTime : pendingReminderDateTime;
    const nextReminderDate = new Date(sourceReminderDate);
    nextReminderDate.setHours(sourceReminderDate.getHours(), sourceReminderDate.getMinutes(), 0, 0);
    const storedReminderDateTime = convertWallDateInTimeZoneToUtcIso(nextReminderDate, form.reminderTimeZone);
    const storedReminderTime = new Date(storedReminderDateTime).getTime();

    if (storedReminderTime < Date.now()) {
      setValidationMessage('Please choose a reminder time that is in the future.');
      return;
    }

    const isDuplicatePending = pendingVariableReminders.some((item) => new Date(item.reminderDateTime).getTime() === storedReminderTime);
    const isDuplicateStatic = form.reminderMode === 'static'
      && getStaticReminderOccurrencesForForm().some((occurrence) => occurrence.getTime() === storedReminderTime);

    if (isDuplicatePending || isDuplicateStatic) {
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
      const nextVariableReminders = sortVariableReminderDrafts([
        ...(event.variableReminders || []),
        {
          id: reminderEntry.id,
          title: 'Custom reminder',
          people: event.people,
          eventDateTime: event.eventDateTime,
          reminderDateTime: reminderEntry.reminderDateTime,
          eventAllDay: event.eventAllDay,
          reminderAllDay: event.reminderAllDay,
          frequency: 'once' as ReminderFrequency,
          notes: event.notes || '',
          notified: false,
        },
      ]);

      const nextReminderDateTime = reminderMode === 'static'
        ? event.reminderDateTime
        : nextVariableReminders[0].reminderDateTime;

      return {
        ...event,
        frequency: reminderMode === 'none' ? 'once' : event.frequency,
        reminderMode: reminderMode === 'none' ? 'variable' : reminderMode,
        reminderDateTime: nextReminderDateTime,
        variableReminders: nextVariableReminders.map((item) => ({
          id: item.id,
          reminderDateTime: item.reminderDateTime,
          notes: item.notes,
        })),
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
        const queueLimitMessage = `iOS can keep at most 64 pending notifications. Scheduling the next ${prioritizedQueue.length} soonest reminders.`;
        if (SHOW_NOTIFICATION_DIAGNOSTICS) {
          setApiStorageStatusMessage(queueLimitMessage);
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
      const shouldShareAfterSave = form.shareAfterSave;
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

      const effectivePendingVariableReminders = form.reminderMode === 'default' && !pendingVariableReminders.length
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

      setEditingEvent(null);
      resetTypeSelectionUi();
      setPendingVariableReminders([]);
      setSeededVariableDraftIds([]);
      setHasTouchedStaticReminderSchedule(false);
      const resetDate = new Date();
      resetDate.setSeconds(0, 0, 0);
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

      if (shouldShareAfterSave) {
        startShareForEvent(newEvent);
        return;
      }

      setCurrentView('landing');

      const savedMessage = variableReminderEntries.length > 0
        ? 'Your event and reminder(s) have been saved.'
        : 'Your event has been saved.';
      Alert.alert('Saved', savedMessage);
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
    setCurrentView('landing');
    setSelectedSummaryEventId(activeReminderEntry.event.id);
  };

  const deleteReminderEntry = async (eventId: string, reminderEntryId: string) => {
    const nextEvents = events.map((event) => {
      if (event.id !== eventId) {
        return event;
      }

      const nextVariableReminders = (event.variableReminders || []).filter((entry) => entry.id !== reminderEntryId);
      const reminderMode = getReminderModeValue(event);

      if (!nextVariableReminders.length) {
        return {
          ...event,
          reminderMode: reminderMode === 'static' ? 'static' : 'none',
          variableReminders: undefined,
        };
      }

      const nextReminderDateTime = nextVariableReminders.reduce((earliest, entry) => (
        new Date(entry.reminderDateTime).getTime() < new Date(earliest.reminderDateTime).getTime() ? entry : earliest
      ), nextVariableReminders[0]).reminderDateTime;

      return {
        ...event,
        reminderMode: reminderMode === 'static' ? 'static' : 'variable',
        variableReminders: nextVariableReminders,
        reminderDateTime: reminderMode === 'static' ? event.reminderDateTime : nextReminderDateTime,
      };
    });

    setEvents(nextEvents);
    await saveEvents(nextEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setConfirmDeleteReminder(null);
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
    const updated = events.filter((event) => event.id !== eventId);
    setEvents(updated);
    await saveEvents(updated, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setActiveReminder(null);
    setConfirmDeleteReminder(null);
    Alert.alert('Removed', 'The event and all associated reminders have been removed.');
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
      };
    });

    setEvents(updatedEvents);
    await saveEvents(updatedEvents, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setRemindersForEventId(null);
    setConfirmDeleteReminder(null);
    Alert.alert('Removed', 'All reminders for this event have been removed.');
  };

  const cancelEvent = async (eventId: string) => {
    const updated = events.filter((event) => event.id !== eventId);
    setEvents(updated);
    await saveEvents(updated, userId);
    const reloaded = await loadEvents(userId);
    setEvents(reloaded);
    setConfirmCancelEventId(null);
    Alert.alert('Deleted', 'The event and all associated reminders have been removed.');
  };

  const formatEventSummary = (event: SpecialDateEvent) => {
    const eventDateLabel = formatEventDateOnly(event);
    if (isAllDaySpecialDateEvent(event)) {
      return `Event: ${eventDateLabel} • All-day`;
    }

    return `Event: ${eventDateLabel} • ${formatEventTimeOnlyLabel(event)}`;
  };

  const formatEventDateOnly = (event: SpecialDateEvent) => {
    const isAllDay = isAllDaySpecialDateEvent(event);
    const startDate = isAllDay
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);

    return startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatEventDateLabel = (event: SpecialDateEvent) => {
    return `Event Date: ${formatEventDateOnly(event)}`;
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

  const applyEventTypeDraftSelection = useCallback(() => {
    if (!eventTypeDraft) {
      return;
    }

    const nextEventType = eventTypeDraft;
    const nextIsAllDay = nextEventType === 'birthday' || nextEventType === 'anniversary';
    const nextShowsSubtype = eventTypeHasSubtype(nextEventType);

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
  }, [eventTypeDraft]);

  const applySubtypeDraftSelection = useCallback(() => {
    if (!subtypeDraft) {
      return;
    }

    setForm((current) => {
      if (current.eventType === 'party') {
        return {
          ...current,
          partySubtype: subtypeDraft as PartySubtypeValue,
          eventAllDay: false,
        };
      }

      if (current.eventType === 'school') {
        return { ...current, schoolSubtype: subtypeDraft as SchoolSubtypeValue };
      }

      if (current.eventType === 'medical') {
        return { ...current, medicalSubtype: subtypeDraft as MedicalSubtypeValue };
      }

      if (current.eventType === 'dental') {
        return { ...current, dentalSubtype: subtypeDraft as DentalSubtypeValue };
      }

      if (current.eventType === 'work') {
        return { ...current, workSubtype: subtypeDraft as WorkSubtypeValue };
      }

      return current;
    });

    setHasSelectedSubtype(true);
    setIsSubtypePickerVisible(false);
    setValidationMessage(null);
  }, [subtypeDraft]);

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
      const shouldShareAfterSave = form.shareAfterSave;
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

      const effectivePendingVariableReminders = form.reminderMode === 'default' && !pendingVariableReminders.length
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

      const updatedEvents = events.map((event) =>
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

      setEvents(updatedEvents);
      setEditingEvent(null);
      resetTypeSelectionUi();
      setPendingVariableReminders([]);
      setSeededVariableDraftIds([]);
      const resetDate = new Date();
      resetDate.setSeconds(0, 0, 0);
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

      if (shouldShareAfterSave && updatedEvent) {
        startShareForEvent(updatedEvent);
        return;
      }

      setCurrentView('landing');

      Alert.alert('Updated', 'The event has been updated.');
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
      const nextDate = new Date(current[field]);
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

  const formatDateTimeLabel = (value: Date, allDay: boolean) => {
    const dateLabel = value.toDateString();
    if (allDay) return `${dateLabel} • All-day`;
    return `${dateLabel} • ${formatTimeLabel(value)}`;
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

  const startShareForEvent = (event: SpecialDateEvent) => {
    setSharingEvent(event);
    setShareManualEmail('');
    setShareManualPhone('');
    setShareRecipients([]);
    setShareMessage('');
    setValidationMessage(null);
    setCurrentView('share');
  };

  const cancelShareFlow = () => {
    setSharingEvent(null);
    setShareManualEmail('');
    setShareManualPhone('');
    setShareRecipients([]);
    setShareMessage('');
    setValidationMessage(null);
    setCurrentView('landing');
  };

  const buildShareDetailsMessage = (
    event: SpecialDateEvent,
    senderName: string,
    customMessage: string,
    acceptLink?: string,
  ) => {
    const acceptExplanation = 'As a registered user of the Remind Me This App clicking the Accept link will load the event into your Saved Events folder.';
    const normalizedCustomMessage = customMessage.trim().slice(0, 255);
    const eventDate = isAllDaySpecialDateEvent(event)
      ? getLocalDateFromUtcDay(event.eventDateTime)
      : new Date(event.eventDateTime);
    const eventDateLabel = eventDate.toLocaleDateString();
    const eventTimeLabel = formatEventTimeOnlyLabel(event);
    const textLines = [
      `An event has been shared with you by ${senderName}.`,
    ];

    if (normalizedCustomMessage) {
      textLines.push(`Message: ${normalizedCustomMessage}`);
    }

    textLines.push(
      `Event Type: ${event.title}`,
      `${event.people}`,
      `Event Date: ${eventDateLabel}`,
      `Event Time: ${eventTimeLabel}`,
    );

    if (acceptLink) {
      textLines.push('');
      textLines.push(acceptExplanation);
      textLines.push('');
      textLines.push(acceptLink);
    }

    const htmlSections = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#111827;">',
      `<div>${escapeHtml(`An event has been shared with you by ${senderName}.`)}</div>`,
    ];

    if (normalizedCustomMessage) {
      htmlSections.push(`<div style="margin-top:8px;">${escapeHtml(`Message: ${normalizedCustomMessage}`)}</div>`);
    }

    htmlSections.push(
      `<div style="margin-top:8px;">${escapeHtml(`Event Type: ${event.title}`)}</div>`,
      `<div>${escapeHtml(event.people)}</div>`,
      `<div>${escapeHtml(`Event Date: ${eventDateLabel}`)}</div>`,
      `<div>${escapeHtml(`Event Time: ${eventTimeLabel}`)}</div>`,
    );

    if (acceptLink) {
      htmlSections.push('<div style="height:12px;"></div>');
      htmlSections.push(`<div>${escapeHtml(acceptExplanation)}</div>`);
      htmlSections.push('<div style="height:8px;"></div>');
      htmlSections.push(`<div><a href="${escapeHtml(acceptLink)}">${escapeHtml(acceptLink)}</a></div>`);
    }

    htmlSections.push('</div>');

    return {
      text: textLines.join('\n'),
      html: htmlSections.join(''),
    };
  };

  const handleSendShare = async () => {
    if (isSendingShare) {
      return;
    }
    if (!sharingEvent) {
      setValidationMessage('Please select an event to share.');
      setCurrentView('landing');
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
    const inviteRecipients = new Set<string>();
    const shareDraftParts: string[] = [];
    const sentEmails = new Set<string>();
    const sentPhones = new Set<string>();

    for (const recipient of shareRecipients) {
      const normalizedEmail = recipient.email?.trim().toLowerCase() || '';
      const normalizedRecipientPhone = recipient.phone ? recipient.phone.replace(/\D/g, '').slice(0, 10) : '';

      if ((normalizedEmail && currentUserEmail && normalizedEmail === currentUserEmail)
        || (normalizedRecipientPhone && currentUserPhoneDigits && normalizedRecipientPhone === currentUserPhoneDigits)) {
        deliveryErrors.push(`Skipped ${recipient.label}: you cannot share an event with yourself.`);
        continue;
      }

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

      const sharePayload = buildShareDetailsMessage(sharingEvent, senderName, shareMessage, acceptLinkForKnownRecipient);

      const shouldAlsoUseContactChannels = recipient.source === 'contact' || recipient.source === 'group';

      if (matchedRecipientUserId) {
        inviteRecipients.add(matchedRecipientUserId);
        successfulDeliveries.push(`Popup invite to ${recipient.label}`);
        launchedAnyChannel = true;
      }

      let deliveredToRecipient = false;

      if (!matchedRecipientUserId && normalizedEmail && validateEmail(normalizedEmail)) {
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

      if (!matchedRecipientUserId && normalizedRecipientPhone && validatePhoneNumber(recipient.phone || '')) {
        if (sentPhones.has(normalizedRecipientPhone)) {
          deliveryErrors.push(`Skipped duplicate phone for ${recipient.label}.`);
        } else {
          sentPhones.add(normalizedRecipientPhone);
          const smsUrl = `sms:${normalizedRecipientPhone}?body=${encodeURIComponent(sharePayload.text)}`;
          try {
            const openedSms = await openExternalComposer(smsUrl);
            if (openedSms) {
              launchedAnyChannel = true;
              deliveredToRecipient = true;
              successfulDeliveries.push(`Text to ${recipient.label}`);
            } else {
              deliveryErrors.push(`Text messaging is not available for ${recipient.label}.`);
              shareDraftParts.push(`TEXT\nTo: ${recipient.phone}\n\n${sharePayload.text}`);
            }
          } catch {
            deliveryErrors.push(`Unable to open text composer for ${recipient.label}.`);
            shareDraftParts.push(`TEXT\nTo: ${recipient.phone}\n\n${sharePayload.text}`);
          }
        }
      }

      if (!deliveredToRecipient && !matchedRecipientUserId) {
        deliveryErrors.push(`Skipped ${recipient.label}: no app account match and no valid email or mobile phone was available.`);
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

    if (!launchedAnyChannel && deliveryErrors.length) {
      const copied = await copyTextToClipboard(shareDraftParts.join('\n\n--------------------\n\n'));
      setValidationMessage(`${deliveryErrors.join(' ')} ${copied ? 'Share draft copied to clipboard.' : 'Copy the share details manually from your message and try again.'}`.trim());
      setIsSendingShare(false);
      return;
    }

    setIsSendingShare(false);
    Alert.alert('Share sent', 'Your event has been shared');
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
    const nextDate = new Date(value);
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
      updateFieldTime('reminderDateTime', hours, minutes);
      closeTimePicker();
      return;
    }

    setPendingReminderDateTime((current) => {
      const pendingDate = new Date(current);
      pendingDate.setHours(hours, minutes, 0, 0);
      return pendingDate;
    });
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
    setPendingReminderDateTime(new Date(now));
    setPendingReminderMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setForm(getResetFormState(effectiveReminderTimeZone));
    setValidationMessage(null);
    setCurrentView('landing');
  };

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

  const eventDatesByDay = useMemo(() => {
    const dates = new Set<string>();
    events.forEach((event) => {
      const eventDate = isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime);
      dates.add(`${eventDate.getFullYear()}-${eventDate.getMonth()}-${eventDate.getDate()}`);
    });
    return dates;
  }, [events]);

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
    return savedEvents.reduce<Array<SpecialDateEvent[]>>((pages, event, index) => {
      const pageIndex = Math.floor(index / 4);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(event);
      return pages;
    }, []);
  }, [savedEvents]);

  const savedRemindersPages = useMemo(() => {
    return savedReminders.reduce<Array<Array<{ event: SpecialDateEvent; occurrence: Date }>>>((pages, reminder, index) => {
      const pageIndex = Math.floor(index / 4);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(reminder);
      return pages;
    }, []);
  }, [savedReminders]);

  const savedEventsSummaryPages = useMemo(() => {
    return savedEvents.reduce<Array<SpecialDateEvent[]>>((pages, event, index) => {
      const pageIndex = Math.floor(index / 6);
      if (!pages[pageIndex]) {
        pages[pageIndex] = [];
      }
      pages[pageIndex].push(event);
      return pages;
    }, []);
  }, [savedEvents]);

  const savedRemindersSummaryPages = useMemo(() => {
    return savedReminders.reduce<Array<Array<{ event: SpecialDateEvent; occurrence: Date }>>>((pages, reminder, index) => {
      const pageIndex = Math.floor(index / 6);
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
    const entries: Array<{ kind: 'event'; event: SpecialDateEvent }> = [];

    savedEvents.forEach((event) => {
      const eventDate = isAllDaySpecialDateEvent(event)
        ? getLocalDateFromUtcDay(event.eventDateTime)
        : new Date(event.eventDateTime);
      if (eventDate.getFullYear() === targetYear && eventDate.getMonth() === targetMonth && eventDate.getDate() === targetDay) {
        entries.push({ kind: 'event', event });
      }
    });

    return entries;
  }, [savedEvents, selectedCalendarDate]);

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

  const renderLandingView = () => (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.subtitle}>Track birthdays, anniversaries, and other meaningful dates.</Text>

      {apiStorageStatusMessage ? (
        <View style={styles.apiStatusBanner}>
          <Text style={styles.apiStatusBannerText}>{apiStorageStatusMessage}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>New event</Text>
        <Text style={styles.helperText}>Create an event with reminders to keep track of your upcoming dates.</Text>
        <Button title="Create New event" onPress={() => {
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
        }} />
      </View>

      <View style={styles.card}>
        <View style={styles.savedEventsHeader}>
          <View style={styles.savedSectionTitleRow}>
            <Text style={styles.label}>Saved events</Text>
            <TouchableOpacity
              style={[styles.refreshButton, isRefreshingSavedData && styles.actionButtonDisabled]}
              onPress={() => void refreshSavedData()}
              disabled={isRefreshingSavedData}
              activeOpacity={0.8}
            >
              <Text style={styles.refreshButtonText}>{isRefreshingSavedData ? '↻…' : '↻'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.viewControlsRow}>
            <Text style={styles.viewLabel}>Views</Text>
            <View style={styles.viewControlsGroup}>
              <TouchableOpacity
                style={[styles.toggleButton, savedEventsView === 'summary' && styles.toggleButtonActive]}
                onPress={() => setSavedEventsView('summary')}
              >
                <Text style={styles.toggleButtonText}>Summary</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, savedEventsView === 'list' && styles.toggleButtonActive]}
                onPress={() => setSavedEventsView('list')}
              >
                <Text style={styles.toggleButtonText}>Detail</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, savedEventsView === 'calendar' && styles.toggleButtonActive]}
                onPress={() => setSavedEventsView('calendar')}
              >
                <Text style={styles.toggleButtonText}>Calendar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {savedEventsView === 'calendar' ? (
          <View>
            <View style={styles.calendarHeader}>
              <TouchableOpacity onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
                <Text style={styles.variableReminderNav}>←</Text>
              </TouchableOpacity>
              <Text style={styles.variableReminderMonth}>{calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
              <TouchableOpacity onPress={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
                <Text style={styles.variableReminderNav}>→</Text>
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

                const dayKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                const hasEvents = eventDatesByDay.has(dayKey);
                const isSelected = selectedCalendarDate?.toDateString() === day.toDateString();
                const isToday = day.toDateString() === new Date().toDateString();

                return (
                  <TouchableOpacity
                    key={dayKey}
                    style={[styles.dayCell, hasEvents && styles.dayCellWithEvents, isSelected && styles.selectedDayCell]}
                    onPress={() => {
                      setSelectedCalendarDate(day);
                      if (hasEvents) {
                        setSelectedEventPopupDate(day);
                      }
                    }}
                  >
                    <Text style={[styles.dayText, isToday && styles.todayText, isSelected && styles.selectedDayText]}>
                      {day.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {selectedDateEntries.length ? (
              <View style={{ marginTop: 12 }}>
                {selectedDateEntries.filter((entry) => entry.kind === 'event').map((entry) => {
                  if (entry.kind !== 'event') return null;

                  return (
                    <View key={entry.event.id} style={styles.eventRow}>
                      <View style={styles.eventContentRow}>
                        <View style={styles.eventDetails}>
                          <Text style={styles.eventTitle}>{entry.event.title}</Text>
                          <Text>{entry.event.people}</Text>
                          <Text numberOfLines={1} ellipsizeMode="tail">{formatEventSummary(entry.event)}</Text>
                          {entry.event.notes ? <Text style={styles.notesText}>{entry.event.notes}</Text> : null}
                          <TouchableOpacity
                            onPress={() => openRemindersForEvent(entry.event)}
                            disabled={!getReminderSummaryState(entry.event).isActive}
                          >
                            <Text
                              style={[
                                styles.reminderCountLink,
                                !getReminderSummaryState(entry.event).isActive && styles.reminderCountLinkDisabled,
                              ]}
                            >
                              {getReminderSummaryState(entry.event).label}
                            </Text>
                          </TouchableOpacity>
                        </View>
                        <View style={styles.actionColumn}>
                          <View style={styles.viewControlsRow}>
                            <Text style={styles.viewLabel}>Actions</Text>
                            <View style={styles.viewControlsGroup}>
                              <TouchableOpacity
                                style={styles.toggleButton}
                                onPress={() => startShareForEvent(entry.event)}
                              >
                                <Text style={styles.toggleButtonText}>Share</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.toggleButton} onPress={() => startEditingEvent(entry.event)}>
                                <Text style={styles.toggleButtonText}>Modify</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.toggleButton} onPress={() => setConfirmCancelEventId(entry.event.id)}>
                                <Text style={styles.toggleButtonText}>Delete</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                          {(() => {
                            const addressLines = getEventLocationDisplayLines(entry.event.eventLocation);
                            if (!addressLines.length) {
                              return null;
                            }

                            return (
                              <View style={styles.savedEventAddressBlock}>
                                {addressLines.map((line, index) => (
                                  <Text key={`${entry.event.id}-calendar-address-${index}`} style={styles.savedEventAddressLine}>{line}</Text>
                                ))}
                              </View>
                            );
                          })()}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.helperText}>Select a highlighted day to see its events.</Text>
            )}
          </View>
        ) : savedEventsView === 'summary' ? (
          <View>
            {currentSavedEventsSummaryPageItems.map((event) => (
              <TouchableOpacity
                key={event.id}
                style={styles.summaryLink}
                onPress={() => {
                  openSummaryEventDetails(event.id);
                }}
              >
                <Text style={styles.summaryLinkText} numberOfLines={1} ellipsizeMode="tail">{event.title} • {event.people} • {formatEventSummary(event)}</Text>
              </TouchableOpacity>
            ))}
            {savedEventsSummaryPages.length > 1 ? (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedEventsSummaryPage === 0 && styles.actionButtonDisabled]}
                  onPress={() => setSavedEventsSummaryPage((page) => Math.max(0, page - 1))}
                  disabled={safeSavedEventsSummaryPage === 0}
                >
                  <Text style={styles.reminderDeleteButtonText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.reminderListNotes}>Page {safeSavedEventsSummaryPage + 1} of {savedEventsSummaryPages.length}</Text>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedEventsSummaryPage >= savedEventsSummaryPages.length - 1 && styles.actionButtonDisabled]}
                  onPress={() => setSavedEventsSummaryPage((page) => Math.min(savedEventsSummaryPages.length - 1, page + 1))}
                  disabled={safeSavedEventsSummaryPage >= savedEventsSummaryPages.length - 1}
                >
                  <Text style={styles.reminderDeleteButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : (
          <View>
            {currentSavedEventsPageItems.map((event) => (
              <View key={event.id} style={styles.eventRow}>
                <View style={styles.eventContentRow}>
                  <View style={styles.eventDetails}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={[styles.eventTitle, { flex: 1 }]}>{event.title}</Text>
                      <TouchableOpacity
                        onPress={() => openRemindersForEvent(event)}
                        disabled={!getReminderSummaryState(event).isActive}
                      >
                        <Text
                          style={[
                            styles.reminderCountLink,
                            !getReminderSummaryState(event).isActive && styles.reminderCountLinkDisabled,
                          ]}
                        >
                          {getReminderSummaryState(event).label}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <Text>{event.people}</Text>
                    <Text numberOfLines={1} ellipsizeMode="tail">{formatEventDateLabel(event)}</Text>
                    <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">{formatEventTimeOnlyLabel(event)}</Text>
                    {event.notes ? <Text style={styles.notesText}>{event.notes}</Text> : null}
                  </View>
                  <View style={styles.actionColumn}>
                    <View style={styles.viewControlsRow}>
                      <Text style={styles.viewLabel}>Actions</Text>
                      <View style={styles.viewControlsGroup}>
                        <TouchableOpacity
                          style={styles.toggleButton}
                          onPress={() => startShareForEvent(event)}
                        >
                          <Text style={styles.toggleButtonText}>Share</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toggleButton} onPress={() => startEditingEvent(event)}>
                          <Text style={styles.toggleButtonText}>Modify</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toggleButton} onPress={() => setConfirmCancelEventId(event.id)}>
                          <Text style={styles.toggleButtonText}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                </View>
                {(() => {
                  const addressLines = getEventLocationDisplayLines(event.eventLocation);
                  if (!addressLines.length) {
                    return null;
                  }

                  return (
                    <View style={styles.savedEventAddressBlock}>
                      {addressLines.map((line, index) => (
                        <Text key={`${event.id}-detail-address-${index}`} style={styles.savedEventAddressLine}>{line}</Text>
                      ))}
                    </View>
                  );
                })()}
              </View>
            ))}
            {savedEventsPages.length > 1 ? (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedEventsPage === 0 && styles.actionButtonDisabled]}
                  onPress={() => setSavedEventsPage((page) => Math.max(0, page - 1))}
                  disabled={safeSavedEventsPage === 0}
                >
                  <Text style={styles.reminderDeleteButtonText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.reminderListNotes}>Page {safeSavedEventsPage + 1} of {savedEventsPages.length}</Text>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedEventsPage >= savedEventsPages.length - 1 && styles.actionButtonDisabled]}
                  onPress={() => setSavedEventsPage((page) => Math.min(savedEventsPages.length - 1, page + 1))}
                  disabled={safeSavedEventsPage >= savedEventsPages.length - 1}
                >
                  <Text style={styles.reminderDeleteButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.savedEventsHeader}>
          <View style={styles.savedSectionTitleRow}>
            <Text style={styles.label}>Saved reminders</Text>
            <TouchableOpacity
              style={[styles.refreshButton, isRefreshingSavedData && styles.actionButtonDisabled]}
              onPress={() => void refreshSavedData()}
              disabled={isRefreshingSavedData}
              activeOpacity={0.8}
            >
              <Text style={styles.refreshButtonText}>{isRefreshingSavedData ? '↻…' : '↻'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.viewControlsRow}>
            <Text style={styles.viewLabel}>Views</Text>
            <View style={styles.viewControlsGroup}>
              <TouchableOpacity
                style={[styles.toggleButton, savedRemindersView === 'summary' && styles.toggleButtonActive]}
                onPress={() => setSavedRemindersView('summary')}
              >
                <Text style={styles.toggleButtonText}>Summary</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, savedRemindersView === 'list' && styles.toggleButtonActive]}
                onPress={() => setSavedRemindersView('list')}
              >
                <Text style={styles.toggleButtonText}>Detail</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, savedRemindersView === 'calendar' && styles.toggleButtonActive]}
                onPress={() => {
                  setSavedRemindersView('calendar');
                  if (savedReminders.length) {
                    const firstReminder = savedReminders[0];
                    setSavedRemindersCalendarMonth(new Date(firstReminder.occurrence.getFullYear(), firstReminder.occurrence.getMonth(), 1));
                  }
                }}
              >
                <Text style={styles.toggleButtonText}>Calendar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        {savedRemindersView === 'calendar' ? (
          <View>
            <View style={styles.calendarHeader}>
              <TouchableOpacity onPress={() => setSavedRemindersCalendarMonth(new Date(savedRemindersCalendarMonth.getFullYear(), savedRemindersCalendarMonth.getMonth() - 1, 1))}>
                <Text style={styles.variableReminderNav}>←</Text>
              </TouchableOpacity>
              <Text style={styles.variableReminderMonth}>{savedRemindersCalendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
              <TouchableOpacity onPress={() => setSavedRemindersCalendarMonth(new Date(savedRemindersCalendarMonth.getFullYear(), savedRemindersCalendarMonth.getMonth() + 1, 1))}>
                <Text style={styles.variableReminderNav}>→</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.weekRow}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <Text key={day} style={styles.weekDay}>{day}</Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {getCalendarDays(savedRemindersCalendarMonth).map((day, index) => {
                if (!day) {
                  return <View key={`empty-${index}`} style={styles.dayCell} />;
                }

                const dayKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                const hasReminder = upcomingReminderDates.has(dayKey);
                const isToday = day.toDateString() === new Date().toDateString();

                return (
                  <TouchableOpacity
                    key={dayKey}
                    style={[styles.dayCell, hasReminder && styles.dayCellWithReminder]}
                    onPress={() => {
                      setSelectedReminderDetail(null);
                      setSelectedReminderCalendarDate(day);
                      setSelectedReminderPopup(day);
                    }}
                  >
                    <Text style={[styles.dayText, isToday && styles.todayText]}>{day.getDate()}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.helperText}>Tap a highlighted day to see its reminders.</Text>
          </View>
        ) : savedRemindersView === 'summary' ? (
          <View>
            {currentSavedRemindersSummaryPageItems.map(({ event, occurrence }) => (
              <TouchableOpacity
                key={`${event.id}-${occurrence.getTime()}`}
                style={styles.summaryLink}
                onPress={() => {
                  const reminderDate = new Date(occurrence);
                  setSelectedReminderCalendarDate(null);
                  setSelectedReminderDetail({ eventId: event.id, occurrenceTime: reminderDate.getTime() });
                  setSelectedReminderPopup(reminderDate);
                }}
              >
                <Text style={styles.summaryLinkText} numberOfLines={1} ellipsizeMode="tail">{event.title} • {event.people} • {occurrence.toLocaleDateString()} • {occurrence.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
              </TouchableOpacity>
            ))}
            {savedRemindersSummaryPages.length > 1 ? (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedRemindersSummaryPage === 0 && styles.actionButtonDisabled]}
                  onPress={() => setSavedRemindersSummaryPage((page) => Math.max(0, page - 1))}
                  disabled={safeSavedRemindersSummaryPage === 0}
                >
                  <Text style={styles.reminderDeleteButtonText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.reminderListNotes}>Page {safeSavedRemindersSummaryPage + 1} of {savedRemindersSummaryPages.length}</Text>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedRemindersSummaryPage >= savedRemindersSummaryPages.length - 1 && styles.actionButtonDisabled]}
                  onPress={() => setSavedRemindersSummaryPage((page) => Math.min(savedRemindersSummaryPages.length - 1, page + 1))}
                  disabled={safeSavedRemindersSummaryPage >= savedRemindersSummaryPages.length - 1}
                >
                  <Text style={styles.reminderDeleteButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : (
          <View>
            {currentSavedRemindersPageItems.map(({ event, occurrence }) => (
              <View key={`${event.id}-${occurrence.getTime()}`} style={[styles.eventRow, styles.eventContentRow]}>
                <View style={styles.eventDetails}>
                  <Text style={styles.eventTitle}>{event.title}</Text>
                  <Text>{event.people}</Text>
                  <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">{formatEventSummary(event)}</Text>
                  <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Reminder: {formatDisplayDate(occurrence, event.reminderAllDay)}</Text>
                  {event.notes ? <Text style={styles.notesText}>{event.notes}</Text> : null}
                </View>
                <View style={styles.actionColumn}>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => {
                      const reminderEntryId = event.variableReminders?.find((entry) => new Date(entry.reminderDateTime).getTime() === occurrence.getTime())?.id;
                      setConfirmDeleteReminder({
                        eventId: event.id,
                        reminderEntryId,
                        reminderSource: reminderEntryId ? 'variable' : 'static',
                        target: 'reminder',
                      });
                    }}
                  >
                    <Text style={styles.actionButtonText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {savedRemindersPages.length > 1 ? (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedRemindersPage === 0 && styles.actionButtonDisabled]}
                  onPress={() => setSavedRemindersPage((page) => Math.max(0, page - 1))}
                  disabled={safeSavedRemindersPage === 0}
                >
                  <Text style={styles.reminderDeleteButtonText}>Back</Text>
                </TouchableOpacity>
                <Text style={styles.reminderListNotes}>Page {safeSavedRemindersPage + 1} of {savedRemindersPages.length}</Text>
                <TouchableOpacity
                  style={[styles.reminderDeleteButton, safeSavedRemindersPage >= savedRemindersPages.length - 1 && styles.actionButtonDisabled]}
                  onPress={() => setSavedRemindersPage((page) => Math.min(savedRemindersPages.length - 1, page + 1))}
                  disabled={safeSavedRemindersPage >= savedRemindersPages.length - 1}
                >
                  <Text style={styles.reminderDeleteButtonText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        )}
      </View>

      <Modal transparent visible={confirmCancelEventId !== null} animationType="fade" onRequestClose={() => {
        if (!isDeletingConfirmedEvent) {
          setConfirmCancelEventId(null);
        }
      }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete event?</Text>
            <Text style={styles.modalBody}>This will permanently remove the event and all associated reminders from your saved list. Are you sure?</Text>
            <View style={styles.confirmActionRow}>
              <View style={styles.confirmActionSide}>
                <Button title="No" onPress={() => {
                  if (!isDeletingConfirmedEvent) {
                    setConfirmCancelEventId(null);
                  }
                }} disabled={isDeletingConfirmedEvent} />
              </View>
              <View style={styles.confirmActionDivider} />
              <View style={styles.confirmActionSide}>
                <Button title={isDeletingConfirmedEvent ? 'Deleting...' : 'Yes'} disabled={isDeletingConfirmedEvent} onPress={async () => {
                  if (!confirmCancelEventId || isDeletingConfirmedEvent) {
                    return;
                  }

                  setIsDeletingConfirmedEvent(true);
                  try {
                    await cancelEvent(confirmCancelEventId);
                  } finally {
                    setIsDeletingConfirmedEvent(false);
                  }
                }} />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={remindersForEventId !== null} animationType="fade" onRequestClose={() => setRemindersForEventId(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Scheduled reminders</Text>
            {(() => {
              const selectedEvent = events.find((event) => event.id === remindersForEventId);
              if (!selectedEvent) return null;

              const reminderEntries = getReminderOccurrencesForEvent(selectedEvent.id).map(({ occurrence }) => {
                const reminderEntryId = selectedEvent.variableReminders?.find((entry) => (
                  new Date(entry.reminderDateTime).getTime() === occurrence.getTime()
                ))?.id;

                return {
                  id: `${selectedEvent.id}-${occurrence.getTime()}`,
                  reminderDateTime: occurrence,
                  source: reminderEntryId ? 'variable' as const : 'static' as const,
                  reminderEntryId,
                };
              });

              const reminderPages = reminderEntries.reduce<Array<Array<typeof reminderEntries[number]>>>((pages, entry, index) => {
                const pageIndex = Math.floor(index / 4);
                if (!pages[pageIndex]) {
                  pages[pageIndex] = [];
                }
                pages[pageIndex].push(entry);
                return pages;
              }, []);

              const safeReminderPage = Math.min(reminderPage, Math.max(0, reminderPages.length - 1));
              const currentReminderPage = reminderPages[safeReminderPage] || [];

              return (
                <View>
                  {currentReminderPage.length ? currentReminderPage.map((entry) => (
                    <View key={`${entry.id}-${entry.reminderDateTime.getTime()}`} style={styles.reminderListItem}>
                      <View style={styles.reminderListRow}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.reminderListDate}>{selectedEvent.title} • {selectedEvent.people}</Text>
                          <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Reminder: {formatDisplayDate(entry.reminderDateTime)}</Text>
                          <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Event date: {formatEventDateOnly(selectedEvent)} • {formatEventTimeOnlyLabel(selectedEvent)}</Text>
                          {selectedEvent.notes ? <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Notes: {selectedEvent.notes}</Text> : null}
                        </View>
                        <TouchableOpacity
                          style={styles.reminderDeleteButton}
                          onPress={() => {
                            setConfirmDeleteReminder({
                              eventId: selectedEvent.id,
                              reminderEntryId: entry.reminderEntryId,
                              reminderSource: entry.source,
                              target: 'reminder',
                            });
                          }}
                        >
                          <Text style={styles.reminderDeleteButtonText}>Delete reminder</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )) : (
                    <Text style={styles.reminderListNotes}>There are no active reminders for this event.</Text>
                  )}
                  {reminderPages.length > 1 ? (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                      <TouchableOpacity
                        style={[styles.reminderDeleteButton, safeReminderPage === 0 && styles.actionButtonDisabled]}
                        onPress={() => setReminderPage((page) => Math.max(0, page - 1))}
                        disabled={safeReminderPage === 0}
                      >
                        <Text style={styles.reminderDeleteButtonText}>Back</Text>
                      </TouchableOpacity>
                      <Text style={styles.reminderListNotes}>Page {safeReminderPage + 1} of {reminderPages.length}</Text>
                      <TouchableOpacity
                        style={[styles.reminderDeleteButton, safeReminderPage >= reminderPages.length - 1 && styles.actionButtonDisabled]}
                        onPress={() => setReminderPage((page) => Math.min(reminderPages.length - 1, page + 1))}
                        disabled={safeReminderPage >= reminderPages.length - 1}
                      >
                        <Text style={styles.reminderDeleteButtonText}>Next</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <TouchableOpacity
                    style={[styles.primaryButton, { marginTop: 8 }]}
                    onPress={() => {
                      setRemindersForEventId(null);
                      setSelectedEventPopupDate(null);
                      setSelectedReminderPopup(null);
                      setSelectedReminderCalendarDate(null);
                      startEditingEvent(selectedEvent);
                    }}
                  >
                    <Text style={styles.primaryButtonText}>Add Reminder(s)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryButton, styles.deleteAllRemindersButton, { marginTop: 8 }]}
                    onPress={() => setConfirmDeleteReminder({ eventId: selectedEvent.id, target: 'all-reminders' })}
                  >
                    <Text style={[styles.primaryButtonText, styles.deleteAllRemindersButtonText]}>Delete All Reminders</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
            <View style={{ marginTop: 8 }}>
              <Button title="Close" onPress={() => setRemindersForEventId(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={selectedEventPopupDate !== null && savedEventsView === 'calendar'}
        animationType="fade"
        onRequestClose={() => setSelectedEventPopupDate(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Saved event details</Text>
            {selectedEventPopupDate ? (
              <View>
                <Text style={styles.modalBody}>{selectedEventPopupDate.toLocaleDateString()}</Text>
                {selectedDateEntries.length ? selectedDateEntries.map((entry) => {
                  const remindersForEvent = getReminderOccurrencesForEvent(entry.event.id);

                  return (
                    <View key={entry.event.id} style={styles.reminderListItem}>
                      <View style={styles.reminderListRow}>
                        <View style={{ flex: 1, minWidth: 0, maxWidth: '100%' }}>
                          <Text style={styles.reminderListDate}>{entry.event.title} • {entry.event.people}</Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                            <Text numberOfLines={1} ellipsizeMode="tail">{formatEventDateLabel(entry.event)}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                            <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">{formatEventTimeOnlyLabel(entry.event)}</Text>
                          </View>
                          {entry.event.notes ? (
                            <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                              <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Notes: {entry.event.notes}</Text>
                            </View>
                          ) : null}
                        </View>
                        <View style={styles.actionColumn}>
                          <TouchableOpacity
                            onPress={() => {
                              setSelectedEventPopupDate(null);
                              openRemindersForEvent(entry.event);
                            }}
                            disabled={!getReminderSummaryState(entry.event).isActive}
                          >
                            <Text
                              style={[
                                styles.reminderCountLink,
                                !getReminderSummaryState(entry.event).isActive && styles.reminderCountLinkDisabled,
                                { flexShrink: 0 },
                              ]}
                            >
                              {getReminderSummaryState(entry.event).label}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      {remindersForEvent.length ? remindersForEvent.map(({ occurrence }, index) => (
                        <Text key={`${entry.event.id}-saved-event-reminder-${occurrence.getTime()}-${index}`} style={styles.reminderListNotes}>
                          Reminder {index + 1}: {formatDisplayDate(occurrence, entry.event.reminderAllDay)}
                        </Text>
                      )) : null}
                    </View>
                  );
                }) : (
                  <Text style={styles.reminderListNotes}>No saved events were found for this day.</Text>
                )}
              </View>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <Button title="Close" onPress={() => setSelectedEventPopupDate(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={selectedSummaryEventId !== null} animationType="fade" onRequestClose={() => setSelectedSummaryEventId(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Saved event details</Text>
            {selectedSummaryEvent ? (
              <View style={styles.eventRow}>
                <View style={styles.eventContentRow}>
                  <View style={styles.eventDetails}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={[styles.eventTitle, { flex: 1 }]}>{selectedSummaryEvent.title}</Text>
                      <TouchableOpacity
                        onPress={() => {
                          setSelectedSummaryEventId(null);
                          openRemindersForEvent(selectedSummaryEvent);
                        }}
                        disabled={!getReminderSummaryState(selectedSummaryEvent).isActive}
                      >
                        <Text
                          style={[
                            styles.reminderCountLink,
                            !getReminderSummaryState(selectedSummaryEvent).isActive && styles.reminderCountLinkDisabled,
                          ]}
                        >
                          {getReminderSummaryState(selectedSummaryEvent).label}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    <Text>{selectedSummaryEvent.people}</Text>
                    <Text numberOfLines={1} ellipsizeMode="tail">{formatEventDateLabel(selectedSummaryEvent)}</Text>
                    <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">{formatEventTimeOnlyLabel(selectedSummaryEvent)}</Text>
                    {selectedSummaryEvent.notes ? <Text style={styles.notesText}>{selectedSummaryEvent.notes}</Text> : null}
                  </View>
                  <View style={styles.actionColumn}>
                    <View style={styles.viewControlsRow}>
                      <Text style={styles.viewLabel}>Actions</Text>
                      <View style={styles.viewControlsGroup}>
                        <TouchableOpacity
                          style={styles.toggleButton}
                          onPress={() => {
                            setSelectedSummaryEventId(null);
                            startShareForEvent(selectedSummaryEvent);
                          }}
                        >
                          <Text style={styles.toggleButtonText}>Share</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.toggleButton}
                          onPress={() => {
                            setSelectedSummaryEventId(null);
                            startEditingEvent(selectedSummaryEvent);
                          }}
                        >
                          <Text style={styles.toggleButtonText}>Modify</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.toggleButton}
                          onPress={() => {
                            setSelectedSummaryEventId(null);
                            setConfirmCancelEventId(selectedSummaryEvent.id);
                          }}
                        >
                          <Text style={styles.toggleButtonText}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    {(() => {
                      const addressLines = getEventLocationDisplayLines(selectedSummaryEvent.eventLocation);
                      if (!addressLines.length) {
                        return null;
                      }

                      return (
                        <View style={styles.savedEventAddressBlock}>
                          {addressLines.map((line, index) => (
                            <Text key={`${selectedSummaryEvent.id}-address-${index}`} style={styles.savedEventAddressLine}>{line}</Text>
                          ))}
                        </View>
                      );
                    })()}
                  </View>
                </View>
              </View>
            ) : (
              <Text style={styles.reminderListNotes}>This event is no longer available.</Text>
            )}
            <View style={{ marginTop: 8 }}>
              <Button title="Close" onPress={() => setSelectedSummaryEventId(null)} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={selectedReminderPopup !== null} animationType="fade" onRequestClose={() => {
        setSelectedReminderPopup(null);
        setSelectedReminderCalendarDate(null);
        setSelectedReminderDetail(null);
      }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reminder details</Text>
            {selectedReminderDetailEntry ? (
              <View>
                <Text style={styles.modalBody}>{selectedReminderDetailEntry.occurrence.toLocaleDateString()}</Text>
                <View style={styles.reminderListItem}>
                  <View style={styles.reminderListRow}>
                    <View style={{ flex: 1, minWidth: 0, maxWidth: '100%' }}>
                      <Text style={styles.reminderListDate}>{selectedReminderDetailEntry.event.title} • {selectedReminderDetailEntry.event.people}</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                        <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Reminder: {formatDisplayDate(selectedReminderDetailEntry.occurrence, selectedReminderDetailEntry.event.reminderAllDay)}</Text>
                      </View>
                      <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                        <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Event date: {formatEventDateOnly(selectedReminderDetailEntry.event)} • {formatEventTimeOnlyLabel(selectedReminderDetailEntry.event)}</Text>
                      </View>
                      {selectedReminderDetailEntry.event.notes ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                          <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Notes: {selectedReminderDetailEntry.event.notes}</Text>
                        </View>
                      ) : null}
                    </View>
                    <TouchableOpacity
                      style={styles.reminderDeleteButton}
                      onPress={async () => {
                        const reminderEntryId = selectedReminderDetailEntry.event.variableReminders?.find((entry) => (
                          new Date(entry.reminderDateTime).getTime() === selectedReminderDetailEntry.occurrence.getTime()
                        ))?.id;

                        if (reminderEntryId) {
                          await deleteReminderEntry(selectedReminderDetailEntry.event.id, reminderEntryId);
                        } else {
                          await deleteStaticReminder(selectedReminderDetailEntry.event.id);
                        }

                        setSelectedReminderPopup(null);
                        setSelectedReminderDetail(null);
                      }}
                    >
                      <Text style={styles.reminderDeleteButtonText}>Delete reminder</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : selectedReminderCalendarDate ? (
              <View>
                <Text style={styles.modalBody}>{selectedReminderCalendarDate.toLocaleDateString()}</Text>
                {selectedReminderDayEvents.length ? selectedReminderDayEvents.map(({ event, occurrence }) => (
                  <View key={`${event.id}-${occurrence.getTime()}`} style={styles.reminderListItem}>
                    <View style={styles.reminderListRow}>
                      <View style={{ flex: 1, minWidth: 0, maxWidth: '100%' }}>
                        <Text style={styles.reminderListDate}>{event.title} • {event.people}</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                          <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Reminder: {formatDisplayDate(occurrence, event.reminderAllDay)}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                          <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Event date: {formatEventDateOnly(event)} • {formatEventTimeOnlyLabel(event)}</Text>
                        </View>
                        {event.notes ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', maxWidth: '100%' }}>
                            <Text style={styles.reminderListNotes} numberOfLines={1} ellipsizeMode="tail">Notes: {event.notes}</Text>
                          </View>
                        ) : null}
                      </View>
                      <TouchableOpacity
                        style={styles.reminderDeleteButton}
                        onPress={async () => {
                          const reminderToDelete = savedReminders.find(({ event: reminderEvent, occurrence: reminderOccurrence }) =>
                            reminderEvent.id === event.id && reminderOccurrence.getTime() === occurrence.getTime(),
                          );

                          if (!reminderToDelete) {
                            return;
                          }

                          const reminderEntryId = reminderToDelete.event.variableReminders?.find((entry) => new Date(entry.reminderDateTime).getTime() === reminderToDelete.occurrence.getTime())?.id;

                          if (reminderEntryId) {
                            await deleteReminderEntry(reminderToDelete.event.id, reminderEntryId);
                          } else {
                            await deleteStaticReminder(reminderToDelete.event.id);
                          }

                          setSelectedReminderPopup(null);
                          setSelectedReminderCalendarDate(null);
                        }}
                      >
                        <Text style={styles.reminderDeleteButtonText}>Delete reminder</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )) : (
                  <Text style={styles.reminderListNotes}>No reminders were found for this day.</Text>
                )}
              </View>
            ) : null}
            <View style={{ marginTop: 8 }}>
              <Button title="Close" onPress={() => {
                setSelectedReminderPopup(null);
                setSelectedReminderCalendarDate(null);
                setSelectedReminderDetail(null);
              }} />
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent visible={confirmDeleteReminder !== null} animationType="fade" onRequestClose={() => {
        if (!isDeletingConfirmedItem) {
          setConfirmDeleteReminder(null);
        }
      }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {confirmDeleteReminder?.target === 'event'
                ? 'Delete event?'
                : confirmDeleteReminder?.target === 'all-reminders'
                  ? 'Delete all reminders?'
                  : 'Delete reminder?'}
            </Text>
            <Text style={styles.modalBody}>
              {confirmDeleteReminder?.target === 'event'
                ? 'This will permanently remove the event and all associated reminders from your saved list. Are you sure?'
                : confirmDeleteReminder?.target === 'all-reminders'
                  ? 'This will remove every scheduled reminder for this event. Continue?'
                    : 'This will permanently remove the selected reminder from the event. Are you sure?'}
            </Text>
            <View style={styles.confirmActionRow}>
              <View style={styles.confirmActionSide}>
                <Button
                  title="No"
                  onPress={() => {
                    if (!isDeletingConfirmedItem) {
                      setConfirmDeleteReminder(null);
                    }
                  }}
                  disabled={isDeletingConfirmedItem}
                />
              </View>
              <View style={styles.confirmActionDivider} />
              <View style={styles.confirmActionSide}>
                <Button title={isDeletingConfirmedItem ? 'Deleting...' : 'Yes'} disabled={isDeletingConfirmedItem} onPress={async () => {
                  if (!confirmDeleteReminder || isDeletingConfirmedItem) return;

                  setIsDeletingConfirmedItem(true);
                  try {
                    if (confirmDeleteReminder.target === 'event') {
                      await deleteReminderEvent(confirmDeleteReminder.eventId);
                    } else if (confirmDeleteReminder.target === 'all-reminders') {
                      await deleteAllRemindersForEvent(confirmDeleteReminder.eventId);
                    } else if (confirmDeleteReminder.reminderSource === 'static') {
                      await deleteStaticReminder(confirmDeleteReminder.eventId);
                    } else if (confirmDeleteReminder.reminderEntryId) {
                      await deleteReminderEntry(confirmDeleteReminder.eventId, confirmDeleteReminder.reminderEntryId);
                    }
                  } finally {
                    setIsDeletingConfirmedItem(false);
                  }
                }} />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={activeShareInvite !== null}
        animationType="fade"
        onRequestClose={() => {
          if (!isRespondingToShareInvite) {
            void respondToActiveShareInvite('dismiss');
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Shared Event Invite</Text>
            {activeShareInvite ? (
              <>
                <Text style={[styles.modalBody, styles.shareInviteBodyText]}>
                  {`${activeShareInvite.sender.fullName || activeShareInvite.sender.email} shared an event with you.`}
                </Text>
                <Text style={[styles.reminderListDate, styles.shareInviteDetailText]}>{`${activeShareInvite.sourceEvent.title} • ${activeShareInvite.sourceEvent.people}`}</Text>
                <Text style={[styles.reminderListNotes, styles.shareInviteDetailText]}>{`Event: ${formatEventDateOnly(activeShareInvite.sourceEvent)} • ${formatEventTimeOnlyLabel(activeShareInvite.sourceEvent)}`}</Text>
                {activeShareInvite.message ? (
                  <Text style={[styles.reminderListNotes, styles.shareInviteDetailText]}>{`Message: ${activeShareInvite.message}`}</Text>
                ) : null}
              </>
            ) : null}
            <View style={styles.shareInviteActionsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.shareInviteActionButton, isRespondingToShareInvite && styles.actionButtonDisabled]}
                disabled={isRespondingToShareInvite}
                onPress={() => {
                  void respondToActiveShareInvite('accept');
                }}
              >
                <Text style={styles.primaryButtonText}>{isRespondingToShareInvite ? 'Working…' : 'Accept'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleButton, styles.shareInviteActionButton, isRespondingToShareInvite && styles.actionButtonDisabled]}
                disabled={isRespondingToShareInvite}
                onPress={() => {
                  void respondToActiveShareInvite('dismiss');
                }}
              >
                <Text style={styles.toggleButtonText}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );

  const renderShareView = () => (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 32 }]}
        keyboardShouldPersistTaps="handled"
      >
      <Text style={styles.title}>Share event</Text>
      <Text style={styles.subtitle}>Send this event to another person by email and/or text.</Text>

      <View style={styles.shareCard}>
        <Text style={styles.label}>Event details</Text>
        {sharingEvent ? (
          <View style={styles.shareEventDetailsCard}>
            <Text style={styles.eventTitle}>{sharingEvent.title}</Text>
            <Text>{sharingEvent.people}</Text>
            <Text style={styles.reminderListNotes}>{formatEventSummary(sharingEvent)}</Text>
          </View>
        ) : (
          <Text style={styles.helperText}>No event selected for sharing.</Text>
        )}

        {validationMessage ? (
          <View style={styles.validationBanner}>
            <Text style={styles.validationBannerText}>{validationMessage}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Share event with</Text>
        <View style={styles.shareBuilderCard}>
          {shareContactOptions.length ? (
            <>
              <Text style={styles.viewLabel}>Contacts</Text>
              <View style={styles.shareRecipientPickerRow}>
                <View style={styles.shareRecipientPickerWrapper}>
                  <Picker
                    selectedValue={selectedShareContactId}
                    onValueChange={(value) => setSelectedShareContactId(String(value))}
                    style={styles.picker}
                  >
                    <Picker.Item label="Select contact" value="" />
                    {shareContactOptions.map((option) => (
                      <Picker.Item key={option.value} label={option.label} value={option.value} />
                    ))}
                  </Picker>
                </View>
                <TouchableOpacity style={styles.shareRecipientAddButton} onPress={addSelectedShareContact}>
                  <Text style={styles.primaryButtonText}>Add</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.viewLabel}>Contacts <Text style={styles.helperText}>(No Contacts Available)</Text></Text>
              <Text style={styles.helperText}>Setup contacts in Account screen.</Text>
            </>
          )}

          {shareGroupOptions.length ? (
            <>
              <Text style={styles.viewLabel}>Groups</Text>
              <View style={styles.shareRecipientPickerRow}>
                <View style={styles.shareRecipientPickerWrapper}>
                  <Picker
                    selectedValue={selectedShareGroupId}
                    onValueChange={(value) => setSelectedShareGroupId(String(value))}
                    style={styles.picker}
                  >
                    <Picker.Item label="Select group" value="" />
                    {shareGroupOptions.map((option) => (
                      <Picker.Item key={option.value} label={option.label} value={option.value} />
                    ))}
                  </Picker>
                </View>
                <TouchableOpacity style={styles.shareRecipientAddButton} onPress={addSelectedShareGroup}>
                  <Text style={styles.primaryButtonText}>Add</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.viewLabel}>Groups <Text style={styles.helperText}>(No Groups Available)</Text></Text>
              <Text style={styles.helperText}>Setup groups in Account screen.</Text>
            </>
          )}

          <Text style={styles.viewLabel}>Individual email</Text>
          <View style={styles.shareRecipientPickerRow}>
            <TextInput
              style={[styles.input, styles.shareRecipientInlineInput]}
              value={shareManualEmail}
              onChangeText={(value) => setShareManualEmail(value)}
              placeholder="name@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.shareRecipientAddButton} onPress={addManualEmailRecipient}>
              <Text style={styles.primaryButtonText}>Add</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.viewLabel}>Individual mobile phone</Text>
          <View style={styles.shareRecipientPickerRow}>
            <TextInput
              style={[styles.input, styles.shareRecipientInlineInput]}
              value={shareManualPhone}
              onChangeText={(value) => setShareManualPhone(formatPhoneNumberInput(value))}
              placeholder="(555) 555-5555"
              keyboardType="phone-pad"
              maxLength={14}
            />
            <TouchableOpacity
              style={[
                styles.shareRecipientAddButton,
                !reminderDeliveryTextEnabled && styles.shareRecipientAddButtonDisabled,
              ]}
              onPress={addManualPhoneRecipient}
              disabled={!reminderDeliveryTextEnabled}
            >
              <Text style={styles.primaryButtonText}>Add</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.viewLabel}>Recipient list</Text>
          {shareRecipients.length ? (
            <View style={styles.shareRecipientList}>
              {shareRecipients.map((recipient) => (
                <View key={recipient.key} style={styles.shareRecipientCard}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.reminderListDate} numberOfLines={1}>{recipient.label}</Text>
                    {recipient.email ? <Text style={styles.reminderListNotes} numberOfLines={1}>{recipient.email}</Text> : null}
                    {recipient.phone ? <Text style={styles.reminderListNotes} numberOfLines={1}>{formatPhoneNumberInput(recipient.phone)}</Text> : null}
                  </View>
                  <TouchableOpacity style={styles.toggleButton} onPress={() => removeShareRecipient(recipient.key)}>
                    <Text style={styles.toggleButtonText}>Remove</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.helperText}>Build a recipient list from contacts, groups, or individual email and phone entries.</Text>
          )}
        </View>

        <Text style={styles.label}>Delivery routing</Text>
        <Text style={styles.helperText}>
          Registered app users receive an in-app popup invite. Contacts without an app account use any populated email and mobile phone values. Manual email and phone entries send to those exact destinations.
        </Text>

        <Text style={styles.label}>Message to recipient</Text>
        <TextInput
          style={[styles.input, styles.notesInput]}
          value={shareMessage}
          onChangeText={(value) => setShareMessage(value)}
          placeholder="Optional message"
          multiline
          maxLength={255}
        />

        <View style={styles.shareActionsRow}>
          <TouchableOpacity
            style={[styles.primaryButton, styles.shareActionButton, isSendingShare && styles.actionButtonDisabled]}
            onPress={() => void handleSendShare()}
            disabled={isSendingShare}
          >
            <Text style={styles.primaryButtonText}>{isSendingShare ? 'Sending…' : 'Send'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.toggleButton, styles.shareActionButton]} onPress={cancelShareFlow} disabled={isSendingShare}>
            <Text style={styles.toggleButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  const renderCreateView = () => {
    const effectiveEventEndDateTime = resolveEventEndDateTime(form.eventDateTime, form.eventEndDateTime);
    const subtypeFieldLabel = getSubtypeFieldLabel(form.eventType);
    const subtypeDisplayLabel = getSubtypeDisplayLabel(form);
    const shouldShowSubtypeField = eventTypeHasSubtype(form.eventType);

    return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{editingEvent ? 'Modify Event' : 'Create Event'}</Text>
      <Text style={styles.subtitle}>{editingEvent ? 'Update the event details and reminder schedule.' : 'Set up a new event and reminder schedule.'}</Text>

      {apiStorageStatusMessage ? (
        <View style={styles.apiStatusBanner}>
          <Text style={styles.apiStatusBannerText}>{apiStorageStatusMessage}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.inlineSelectionRow}>
          <Text style={styles.label}>Event type</Text>
          {!isEventTypePickerVisible && hasSelectedEventType ? (
            <TouchableOpacity style={styles.inlineSelectionValueButton} onPress={() => {
              setEventTypeDraft(form.eventType);
              setIsEventTypePickerVisible(true);
            }} activeOpacity={0.8}>
              <Text style={styles.inlineSelectionValueText}>{eventTypeLabels[form.eventType]}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {(isEventTypePickerVisible || !hasSelectedEventType) ? (
          <View style={styles.pickerWrapper}>
            <Picker
              selectedValue={eventTypeDraft}
              onValueChange={(value) => setEventTypeDraft(value as EventTypeValue | '')}
              style={styles.picker}
            >
              <Picker.Item label="Select event type" value="" />
              {eventTypeOptions.map((option) => (
                <Picker.Item key={option.value} label={option.label} value={option.value} />
              ))}
            </Picker>
            <TouchableOpacity
              style={[styles.toggleButton, styles.inlineSelectionConfirmButton, !eventTypeDraft && styles.actionButtonDisabled]}
              onPress={applyEventTypeDraftSelection}
              disabled={!eventTypeDraft}
            >
              <Text style={styles.toggleButtonText}>Select event type</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {shouldShowSubtypeField && subtypeFieldLabel ? (
          <>
            <View style={styles.inlineSelectionRow}>
              <Text style={styles.label}>{subtypeFieldLabel}</Text>
              {!isSubtypePickerVisible && hasSelectedSubtype ? (
                <TouchableOpacity style={styles.inlineSelectionValueButton} onPress={() => {
                  setSubtypeDraft(getSubtypeValueForEventType(form, form.eventType));
                  setIsSubtypePickerVisible(true);
                }} activeOpacity={0.8}>
                  <Text style={styles.inlineSelectionValueText}>{subtypeDisplayLabel}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {(isSubtypePickerVisible || !hasSelectedSubtype) ? (
              <View style={styles.pickerWrapper}>
                <Picker
                  selectedValue={subtypeDraft}
                  onValueChange={(value) => setSubtypeDraft(String(value || ''))}
                  style={styles.picker}
                >
                  <Picker.Item label={`Select ${subtypeFieldLabel.toLowerCase()}`} value="" />
                  {form.eventType === 'party' ? Object.entries(partySubtypeLabels).map(([value, label]) => (
                    <Picker.Item key={value} label={label} value={value} />
                  )) : null}
                  {form.eventType === 'school' ? Object.entries(schoolSubtypeLabels).map(([value, label]) => (
                    <Picker.Item key={value} label={label} value={value} />
                  )) : null}
                  {form.eventType === 'medical' ? Object.entries(medicalSubtypeLabels).map(([value, label]) => (
                    <Picker.Item key={value} label={label} value={value} />
                  )) : null}
                  {form.eventType === 'dental' ? Object.entries(dentalSubtypeLabels).map(([value, label]) => (
                    <Picker.Item key={value} label={label} value={value} />
                  )) : null}
                  {form.eventType === 'work' ? Object.entries(workSubtypeLabels).map(([value, label]) => (
                    <Picker.Item key={value} label={label} value={value} />
                  )) : null}
                </Picker>
                <TouchableOpacity
                  style={[styles.toggleButton, styles.inlineSelectionConfirmButton, !subtypeDraft && styles.actionButtonDisabled]}
                  onPress={applySubtypeDraftSelection}
                  disabled={!subtypeDraft}
                >
                  <Text style={styles.toggleButtonText}>Select subtype</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : null}

        {form.eventType === 'other' && (
          <>
            <Text style={styles.label}>Custom event type</Text>
            <TextInput
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
          style={styles.input}
          value={form.people}
          onChangeText={(value) => setForm({ ...form, people: value })}
          placeholder="Enter a person, people, group, place or description"
        />

        {form.eventType === 'birthday' ? (
          <>
            <Text style={styles.label}>Age as of today</Text>
            <TextInput
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
                  return {
                    ...current,
                    eventLocationEnabled: false,
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
                    style={[styles.input, styles.eventLocationZipInput]}
                    value={form.eventLocationZip}
                    onChangeText={(value) => setForm({ ...form, eventLocationZip: normalizeZipCode(value) })}
                    placeholder="ZIP"
                    keyboardType="number-pad"
                    maxLength={5}
                  />
                </View>
                <TextInput
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

        <Text style={styles.label}>Event start date</Text>
        <Button title={formatDateTimeLabel(form.eventDateTime, isAllDayEvent(form.eventType, form.partySubtype, form.eventAllDay))} onPress={() => openDatePicker('event')} />

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
                  <Text style={styles.label}>Event start time</Text>
                  <TouchableOpacity
                    style={styles.timeValueButton}
                    onPress={() => openTimePicker('event-start', 'Start time', form.eventDateTime)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.timeValueButtonText}>{formatTimeLabel(form.eventDateTime)}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.eventTimeGroup}>
                  <Text style={styles.label}>Event end time</Text>
                  <TouchableOpacity
                    style={styles.timeValueButton}
                    onPress={() => openTimePicker('event-end', 'End time', effectiveEventEndDateTime)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.timeValueButtonText}>{formatTimeLabel(effectiveEventEndDateTime)}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Event start time</Text>
                <TouchableOpacity
                  style={styles.timeValueButton}
                  onPress={() => openTimePicker('event-start', 'Start time', form.eventDateTime)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.timeValueButtonText}>{formatTimeLabel(form.eventDateTime)}</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}

        <Text style={styles.label}>Event Notes</Text>
        <TextInput
          style={[styles.input, styles.notesInput]}
          multiline
          value={form.notes}
          onChangeText={(value) => setForm({ ...form, notes: value })}
          placeholder="Optional details"
        />

        <TouchableOpacity
          style={styles.shareOptionRow}
          onPress={() => setForm((current) => ({
            ...current,
            shareAfterSave: !current.shareAfterSave,
          }))}
          activeOpacity={0.8}
        >
          <View style={styles.shareRadioOuter}>
            {form.shareAfterSave ? <View style={styles.shareRadioInner} /> : null}
          </View>
          <Text style={styles.preferenceToggleText}>Share Event With Others</Text>
        </TouchableOpacity>
        <Text style={styles.label}>Reminder Creation Mode</Text>
          <View style={[styles.row, styles.reminderModeRow]}>
          {([
            { value: 'none' as ReminderModeValue, label: 'None' },
            { value: 'default' as ReminderModeValue, label: 'Default' },
              { value: 'static' as ReminderModeValue, label: 'Recur' },
            { value: 'variable' as ReminderModeValue, label: 'Custom' },
          ]).map((option) => {
            const isSelected = form.reminderMode === option.value;
            return (
              <Pressable
                key={option.value}
                  style={[
                    styles.frequencyOption,
                    styles.reminderModeOption,
                    isSelected ? styles.frequencyOptionSelected : styles.frequencyOptionUnselected,
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
                    styles.frequencyOptionText,
                    styles.reminderModeOptionText,
                    isSelected ? styles.frequencyOptionTextSelected : styles.frequencyOptionTextUnselected,
                  ]}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {hoveredReminderMode ? (
          <Text style={styles.helperText}>{getReminderModeHoverMessage(hoveredReminderMode)}</Text>
        ) : null}

        {isNoReminderMode(form.reminderMode) && (
          <Text style={styles.helperText}>You can add reminders later from the saved event details.</Text>
        )}

        {form.reminderMode === 'static' && (
          <>
            <Text style={styles.label}>Reminder frequency</Text>
            <View style={styles.row}>
              {(['daily', 'weekly', 'monthly', 'yearly'] as ReminderFrequency[]).map((option) => {
                const isSelected = form.frequency === option;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[styles.frequencyOption, isSelected ? styles.frequencyOptionSelected : styles.frequencyOptionUnselected]}
                    onPress={() => setForm({ ...form, frequency: option })}
                    disabled={isSelected}
                  >
                    <Text style={[styles.frequencyOptionText, isSelected ? styles.frequencyOptionTextSelected : styles.frequencyOptionTextUnselected]}>
                      {option}
                    </Text>
                  </TouchableOpacity>
                );
              })}
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
                  <Text style={styles.timeValueButtonText}>{formatTimeLabel(form.reminderDateTime)}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.primaryButton} onPress={addPendingVariableReminder}>
                  <Text style={styles.addReminderButtonText}>{`Add\nReminder(s)`}</Text>
                </TouchableOpacity>
                <Text style={styles.reminderActionHint}>
                  (Choose a time,{`\n`}click Add Reminder(s) to add to reminder list.)
                </Text>
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
                  <Text style={styles.timeValueButtonText}>{formatTimeLabel(pendingReminderDateTime)}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.primaryButton} onPress={addPendingVariableReminder}>
                  <Text style={styles.addReminderButtonText}>{`Add\nReminder(s)`}</Text>
                </TouchableOpacity>
                <Text style={styles.reminderActionHint}>
                  (Choose a time,{`\n`}click Add Reminder(s) to add to reminder list.)
                </Text>
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

        <View style={{ marginTop: 8 }}>
          <Button title="Cancel" onPress={cancelCreateFlow} />
        </View>
        <View style={{ marginTop: 8 }}>
          <TouchableOpacity
            activeOpacity={0.8}
            style={[styles.primaryButton, isSavingEvent && styles.actionButtonDisabled]}
            disabled={isSavingEvent}
            onPress={() => {
              if (editingEvent) {
                void saveEditedEvent();
              } else {
                void saveCurrentEvent();
              }
            }}
          >
            <Text style={styles.primaryButtonText}>{isSavingEvent ? 'Saving…' : editingEvent ? 'Save changes' : 'SAVE'}</Text>
          </TouchableOpacity>
        </View>
      </View>

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

    </ScrollView>
    );
  };

  return (
    <>
      {currentView === 'landing' ? renderLandingView() : currentView === 'share' ? renderShareView() : renderCreateView()}
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

const styles = StyleSheet.create({
  container: {
    padding: 24,
    paddingBottom: 40,
    backgroundColor: '#f5f7ff',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#5f6b7a',
    marginBottom: 16,
  },
  helperText: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 10,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  shareCard: {
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  shareEventDetailsCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    backgroundColor: '#f8fafc',
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
    borderColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  shareRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#2563eb',
  },
  shareActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  shareBuilderCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#f8fafc',
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
    borderColor: '#d9e2f0',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  shareRecipientInlineInput: {
    flex: 1,
    marginBottom: 0,
    backgroundColor: '#fff',
  },
  shareRecipientAddButton: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareRecipientAddButtonDisabled: {
    backgroundColor: '#94a3b8',
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
    borderColor: '#d9e2f0',
    borderRadius: 10,
    padding: 10,
    backgroundColor: '#fff',
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
  },
  inlineSelectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  inlineSelectionValueButton: {
    paddingVertical: 4,
  },
  inlineSelectionValueText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  inlineSelectionConfirmButton: {
    alignSelf: 'flex-start',
    marginTop: 6,
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
    backgroundColor: '#e2e8f0',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  refreshButtonText: {
    color: '#334155',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 16,
  },
  toggleButton: {
    backgroundColor: '#e2e8f0',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toggleButtonActive: {
    backgroundColor: '#bfdbfe',
  },
  toggleButtonText: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '600',
  },
  viewControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  viewLabel: {
    color: '#475569',
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
    borderColor: '#d9e2f0',
    borderRadius: 10,
    padding: 8,
    backgroundColor: '#f8fafc',
    alignSelf: 'stretch',
    alignItems: 'stretch',
    width: '100%',
  },
  savedEventAddressLine: {
    color: '#0f172a',
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
    borderColor: '#d9e2f0',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  validationBanner: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  validationBannerText: {
    color: '#b91c1c',
    fontWeight: '600',
  },
  apiStatusBanner: {
    backgroundColor: '#fef3c7',
    borderColor: '#f59e0b',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  apiStatusBannerText: {
    color: '#92400e',
    fontWeight: '600',
  },
  pickerWrapper: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
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
  eventLocationRadioOuter: {
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  eventLocationRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#2563eb',
  },
  eventLocationToggleText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '500',
  },
  eventLocationSuggestionsList: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    marginBottom: 8,
    overflow: 'hidden',
  },
  eventLocationSuggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  eventLocationSuggestionMainText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '600',
  },
  eventLocationSuggestionSecondaryText: {
    color: '#64748b',
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
    borderColor: '#d9e2f0',
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
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
    borderColor: '#2563eb',
    borderRadius: 4,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#2563eb',
  },
  checkboxUnchecked: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  checkboxLabel: {
    color: '#111827',
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
    borderColor: '#d9e2f0',
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  timeValueButtonText: {
    color: '#1d4ed8',
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
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#fff',
  },
  variableReminderClockCard: {
    flex: 0.8,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 9,
    backgroundColor: '#fff',
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
    color: '#6b7280',
    fontWeight: '600',
  },
  variableReminderMonth: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: '#111827',
  },
  variableReminderNav: {
    fontSize: 18,
    color: '#2563eb',
    paddingHorizontal: 8,
  },
  picker: {
    color: '#111827',
  },
  notesInput: {
    minHeight: 70,
    textAlignVertical: 'top',
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
    backgroundColor: '#2563eb',
  },
  frequencyOptionUnselected: {
    backgroundColor: '#e5e7eb',
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
    color: '#fff',
  },
  frequencyOptionTextUnselected: {
    color: '#374151',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 6,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  addReminderButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
  reminderActionHint: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 6,
    width: '100%',
    alignSelf: 'stretch',
    flexShrink: 1,
    flexWrap: 'wrap',
    lineHeight: 16,
  },
  deleteAllRemindersButton: {
    backgroundColor: '#dc2626',
    alignSelf: 'stretch',
  },
  deleteAllRemindersButtonText: {
    textAlign: 'center',
  },
  pendingReminderCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
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
    color: '#111827',
  },
  pendingReminderSubtext: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  pendingReminderRemove: {
    color: '#dc2626',
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 760,
    minWidth: 320,
    alignSelf: 'center',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    gap: 8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  activeReminderCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 0,
    paddingTop: 14,
    paddingBottom: 6,
    overflow: 'hidden',
  },
  activeReminderTitle: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    color: '#111827',
    marginBottom: 8,
  },
  activeReminderEventTitle: {
    fontSize: 22,
    fontWeight: '500',
    textAlign: 'center',
    color: '#111827',
    marginHorizontal: 16,
  },
  activeReminderEventDetails: {
    fontSize: 16,
    textAlign: 'center',
    color: '#111827',
    marginHorizontal: 16,
    marginTop: 2,
  },
  activeReminderActions: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  activeReminderActionButton: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    alignItems: 'center',
  },
  activeReminderActionText: {
    color: '#1d4ed8',
    fontSize: 18,
    fontWeight: '500',
  },
  modalBody: {
    fontSize: 15,
    color: '#111827',
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
    backgroundColor: '#cbd5e1',
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
    color: '#2563eb',
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
    color: '#6b7280',
    fontSize: 12,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
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
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff',
  },
  dayCellWithReminder: {
    borderWidth: 1,
    borderColor: '#ef4444',
    backgroundColor: '#fef2f2',
  },
  selectedDayCell: {
    backgroundColor: '#2563eb',
  },
  dayText: {
    color: '#111827',
  },
  todayText: {
    fontWeight: '700',
    color: '#2563eb',
  },
  selectedDayText: {
    color: '#fff',
    fontWeight: '700',
  },
  nextReminder: {
    fontSize: 16,
    color: '#1d4ed8',
  },
  eventRow: {
    paddingVertical: 10,
    borderTopColor: '#e5e7eb',
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
  summaryLinkText: {
    color: '#2563eb',
    fontWeight: '600',
    textDecorationLine: 'underline',
    flexShrink: 1,
  },
  reminderCountLink: {
    color: '#2563eb',
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  reminderCountLinkDisabled: {
    color: '#64748b',
    textDecorationLine: 'none',
  },
  notesText: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 4,
  },
  frequency: {
    color: '#0f766e',
    marginTop: 2,
  },
  noActiveReminderText: {
    color: '#dc2626',
    fontWeight: '700',
  },
  actionColumn: {
    alignItems: 'flex-end',
    gap: 6,
    marginTop: 8,
  },
  actionButton: {
    backgroundColor: '#e2e8f0',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
    minWidth: 74,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#0f172a',
    fontWeight: '600',
    fontSize: 12,
  },
  actionButtonDisabled: {
    backgroundColor: '#cbd5e1',
    opacity: 0.7,
  },
  reminderListItem: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
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
    color: '#111827',
    flexShrink: 1,
    flexWrap: 'nowrap',
  },
  reminderListNotes: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
    flexShrink: 1,
    flexWrap: 'nowrap',
    maxWidth: '100%',
    overflow: 'hidden',
  },
  reminderDeleteButton: {
    backgroundColor: '#fee2e2',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  reminderDeleteButtonText: {
    color: '#b91c1c',
    fontSize: 12,
    fontWeight: '600',
  },
});
