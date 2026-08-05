import AsyncStorage from '@react-native-async-storage/async-storage';
import { SpecialDateEvent } from './types';
import { getDeviceTimeZone } from './timeZones';

const STORAGE_KEY = 'special-date-events';
const USERS_KEY = 'special-date-users';
const API_MIGRATION_KEY = 'special-date-api-migrated-v1';
const REMINDER_SOUND_SETTINGS_KEY_PREFIX = 'special-date-reminder-sound-settings';
const REMINDER_DELIVERY_SETTINGS_KEY_PREFIX = 'special-date-reminder-delivery-settings';
const REMINDER_DEFAULT_TIME_KEY_PREFIX = 'special-date-reminder-default-time-settings';
const REMINDER_TIME_ZONE_KEY_PREFIX = 'special-date-reminder-time-zone-settings';
const CALENDAR_SYNC_SETTINGS_KEY_PREFIX = 'special-date-reminder-calendar-sync-settings';
const API_BASE_URL = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_BASE_URL
  ? process.env.EXPO_PUBLIC_API_BASE_URL
  : 'http://localhost:4000').replace(/\/$/, '');
const USE_API_STORAGE = typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_USE_API_STORAGE === 'true';
const API_REQUEST_TIMEOUT_MS = 8000;
const EVENT_LOCATION_METADATA_PREFIX = '[SDR_EVENT_LOCATION]';
let apiStorageStatusMessage: string | null = null;
const apiStorageStatusListeners = new Set<(message: string | null) => void>();

function resolveLocaleRegionCode(value: string): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  try {
    const IntlWithLocale = Intl as typeof Intl & { Locale?: new (tag: string) => { region?: string } };
    if (typeof IntlWithLocale.Locale === 'function') {
      const parsed = new IntlWithLocale.Locale(normalized);
      const region = String(parsed.region || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(region)) {
        return region;
      }
    }
  } catch {
    // Fall through to regex parser below.
  }

  const fallbackMatch = normalized.match(/[-_]([A-Za-z]{2})(?:[-_]|$)/);
  if (!fallbackMatch) {
    return null;
  }

  const fallbackRegion = fallbackMatch[1].toUpperCase();
  return /^[A-Z]{2}$/.test(fallbackRegion) ? fallbackRegion : null;
}

function resolveRuntimeRegionCode(): string | null {
  const preferredRegion = typeof process !== 'undefined' && process.env
    ? String(process.env.EXPO_PUBLIC_DEFAULT_REGION_CODE || '').trim().toUpperCase()
    : '';
  if (/^[A-Z]{2}$/.test(preferredRegion)) {
    return preferredRegion;
  }

  const localeCandidates = [
    typeof navigator !== 'undefined' ? String(navigator.language || '').trim() : '',
    typeof Intl !== 'undefined' ? String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim() : '',
  ];

  for (const candidate of localeCandidates) {
    const region = resolveLocaleRegionCode(candidate);
    if (region) {
      return region;
    }
  }

  return null;
}

export interface StoredUser {
  id: string;
  email: string;
  password: string;
  mobileNumber?: string;
  fullName?: string;
  address?: string;
  birthDate?: string;
}

export interface CreateUserResult {
  user?: StoredUser;
  error?: string;
  verificationRequired?: boolean;
  message?: string;
}

export interface SignInResult {
  user: StoredUser | null;
  error?: string;
}

export interface ResendVerificationResult {
  success: boolean;
  message?: string;
  error?: string;
}

export type ReminderSoundPattern = 'single' | 'double';
export type ReminderSoundVolume = 'normal' | 'loud';

export interface ReminderSoundSettings {
  enabled: boolean;
  pattern: ReminderSoundPattern;
  volume: ReminderSoundVolume;
}

export interface ReminderDeliverySettings {
  device: boolean;
  email: boolean;
  text: boolean;
}

export interface ReminderDefaultTimeSettings {
  hour: number;
  minute: number;
}

export interface ReminderTimeZoneSettings {
  timeZone: string;
}

export type CalendarSyncProvider = 'none' | 'google' | 'outlook' | 'apple';
export type CalendarSyncPermission = 'none' | 'read' | 'write';

export interface GoogleCalendarSyncConfig {
  calendarId: string;
  permission: CalendarSyncPermission;
  syncPaused?: boolean;
}

export interface OutlookCalendarSyncConfig {
  email: string;
  syncPaused?: boolean;
}

export interface AppleCalendarSyncConfig {
  appleId: string;
  calendarName: string;
  syncPaused?: boolean;
}

export interface CalendarSyncSettings {
  provider: CalendarSyncProvider;
  google: GoogleCalendarSyncConfig;
  outlook: OutlookCalendarSyncConfig;
  apple: AppleCalendarSyncConfig;
}

export interface GoogleCalendarPushResult {
  success: boolean;
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

export interface GoogleOAuthConnectUrlResult {
  success: boolean;
  authUrl: string;
}

export interface GoogleOAuthConnectionStatusResult {
  connected: boolean;
}

export interface GoogleAddressPrediction {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface GoogleResolvedAddress {
  placeId: string;
  formattedAddress: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
}

export interface OutlookOAuthConnectUrlResult {
  success: boolean;
  authUrl: string;
}

export interface OutlookOAuthConnectionStatusResult {
  connected: boolean;
}

export interface PendingShareInvite {
  id: string;
  message?: string;
  channels?: string;
  createdAt: string;
  sender: {
    id: string;
    email: string;
    fullName?: string;
  };
  sourceEvent: SpecialDateEvent;
}

export interface PendingShareInvitesResult {
  invites: PendingShareInvite[];
}

const getRuntimeAppReturnUrl = () => {
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }

  return String(window.location.origin || '').trim();
};

const defaultReminderSoundSettings: ReminderSoundSettings = {
  enabled: true,
  pattern: 'double',
  volume: 'loud',
};

const defaultReminderDeliverySettings: ReminderDeliverySettings = {
  device: true,
  email: false,
  text: false,
};

const defaultReminderDefaultTimeSettings: ReminderDefaultTimeSettings = {
  hour: 9,
  minute: 0,
};

const defaultReminderTimeZoneSettings: ReminderTimeZoneSettings = {
  timeZone: getDeviceTimeZone(),
};

const defaultCalendarSyncSettings: CalendarSyncSettings = {
  provider: 'none',
  google: {
    calendarId: '',
    permission: 'write',
    syncPaused: false,
  },
  outlook: {
    email: '',
    syncPaused: false,
  },
  apple: {
    appleId: '',
    calendarName: '',
    syncPaused: false,
  },
};

function getUserStorageKey(userId: string) {
  return `${STORAGE_KEY}:${userId}`;
}

function getReminderSoundSettingsKey(userId?: string) {
  return `${REMINDER_SOUND_SETTINGS_KEY_PREFIX}:${userId || 'anonymous'}`;
}

function getReminderDeliverySettingsKey(userId?: string) {
  return `${REMINDER_DELIVERY_SETTINGS_KEY_PREFIX}:${userId || 'anonymous'}`;
}

function getReminderDefaultTimeSettingsKey(userId?: string) {
  return `${REMINDER_DEFAULT_TIME_KEY_PREFIX}:${userId || 'anonymous'}`;
}

function getReminderTimeZoneSettingsKey(userId?: string) {
  return `${REMINDER_TIME_ZONE_KEY_PREFIX}:${userId || 'anonymous'}`;
}

function getCalendarSyncSettingsKey(userId?: string) {
  return `${CALENDAR_SYNC_SETTINGS_KEY_PREFIX}:${userId || 'anonymous'}`;
}

function parseReminderSoundSettings(raw: string | null): ReminderSoundSettings {
  if (!raw) {
    return defaultReminderSoundSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReminderSoundSettings>;
    return {
      enabled: parsed.enabled ?? defaultReminderSoundSettings.enabled,
      pattern: parsed.pattern === 'double' ? 'double' : 'single',
      volume: parsed.volume === 'loud' ? 'loud' : 'normal',
    };
  } catch (error) {
    console.warn('Failed to parse reminder sound settings; using defaults.', error);
    return defaultReminderSoundSettings;
  }
}

function parseReminderDeliverySettings(raw: string | null): ReminderDeliverySettings {
  if (!raw) {
    return defaultReminderDeliverySettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReminderDeliverySettings>;
    return {
      device: parsed.device ?? defaultReminderDeliverySettings.device,
      email: parsed.email ?? defaultReminderDeliverySettings.email,
      text: parsed.text ?? defaultReminderDeliverySettings.text,
    };
  } catch (error) {
    console.warn('Failed to parse reminder delivery settings; using defaults.', error);
    return defaultReminderDeliverySettings;
  }
}

function parseReminderDefaultTimeSettings(raw: string | null): ReminderDefaultTimeSettings {
  if (!raw) {
    return defaultReminderDefaultTimeSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReminderDefaultTimeSettings>;
    const hour = Number.isFinite(parsed.hour) ? Math.max(0, Math.min(23, Math.trunc(parsed.hour as number))) : defaultReminderDefaultTimeSettings.hour;
    const minute = Number.isFinite(parsed.minute) ? Math.max(0, Math.min(59, Math.trunc(parsed.minute as number))) : defaultReminderDefaultTimeSettings.minute;

    return { hour, minute };
  } catch (error) {
    console.warn('Failed to parse reminder default time settings; using defaults.', error);
    return defaultReminderDefaultTimeSettings;
  }
}

function parseReminderTimeZoneSettings(raw: string | null): ReminderTimeZoneSettings {
  if (!raw) {
    return defaultReminderTimeZoneSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReminderTimeZoneSettings>;
    const parsedTimeZone = typeof parsed.timeZone === 'string' ? parsed.timeZone.trim() : '';
    return {
      timeZone: parsedTimeZone || defaultReminderTimeZoneSettings.timeZone,
    };
  } catch (error) {
    console.warn('Failed to parse reminder time zone settings; using defaults.', error);
    return defaultReminderTimeZoneSettings;
  }
}

function parseCalendarSyncSettings(raw: string | null): CalendarSyncSettings {
  if (!raw) {
    return defaultCalendarSyncSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CalendarSyncSettings> & {
      google?: Partial<GoogleCalendarSyncConfig>;
      outlook?: Partial<OutlookCalendarSyncConfig>;
      apple?: Partial<AppleCalendarSyncConfig>;
    };
    const provider = parsed.provider === 'google' || parsed.provider === 'outlook' || parsed.provider === 'apple'
      ? parsed.provider
      : 'none';

    return {
      provider,
      google: {
        calendarId: typeof parsed.google?.calendarId === 'string' ? parsed.google.calendarId.trim() : '',
        permission: parsed.google?.permission === 'write' || parsed.google?.permission === 'read'
          ? parsed.google.permission
          : 'write',
        syncPaused: parsed.google?.syncPaused === true,
      },
      outlook: {
        email: typeof parsed.outlook?.email === 'string' ? parsed.outlook.email.trim() : '',
        syncPaused: parsed.outlook?.syncPaused === true,
      },
      apple: {
        appleId: typeof parsed.apple?.appleId === 'string' ? parsed.apple.appleId.trim() : '',
        calendarName: typeof parsed.apple?.calendarName === 'string' ? parsed.apple.calendarName.trim() : '',
        syncPaused: parsed.apple?.syncPaused === true,
      },
    };
  } catch (error) {
    console.warn('Failed to parse calendar sync settings; using defaults.', error);
    return defaultCalendarSyncSettings;
  }
}

function setApiStorageStatusMessage(message: string | null) {
  apiStorageStatusMessage = message;
  apiStorageStatusListeners.forEach((listener) => listener(apiStorageStatusMessage));
}

export function subscribeApiStorageStatus(listener: (message: string | null) => void) {
  apiStorageStatusListeners.add(listener);
  listener(apiStorageStatusMessage);

  return () => {
    apiStorageStatusListeners.delete(listener);
  };
}

function parseStoredArray<T>(raw: string | null, label: string): T[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    console.warn(`Failed to parse ${label}; defaulting to empty array.`, error);
    return [];
  }
}

async function readStoredUsers(): Promise<StoredUser[]> {
  try {
    const raw = await AsyncStorage.getItem(USERS_KEY);
    return parseStoredArray<StoredUser>(raw, USERS_KEY);
  } catch (error) {
    console.warn('Failed to read local users; defaulting to empty list.', error);
    return [];
  }
}

async function readStoredEvents(storageKey: string): Promise<SpecialDateEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    return parseStoredArray<SpecialDateEvent>(raw, storageKey);
  } catch (error) {
    console.warn(`Failed to read local events for ${storageKey}; defaulting to empty list.`, error);
    return [];
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), API_REQUEST_TIMEOUT_MS);

  if (init?.signal) {
    init.signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: timeoutController.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new Error(`Request timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  return data as T;
}

function mapApiEventToLocal(event: any): SpecialDateEvent {
  const parseEventLocationNotesMetadata = (value: string | null | undefined) => {
    const normalized = typeof value === 'string' ? value : '';
    if (!normalized.trim()) {
      return { cleanedNotes: undefined as string | undefined, eventLocation: undefined as SpecialDateEvent['eventLocation'] };
    }

    const lines = normalized.split('\n');
    const metadataLineIndex = [...lines].reverse().findIndex((line) => line.startsWith(EVENT_LOCATION_METADATA_PREFIX));
    if (metadataLineIndex === -1) {
      return { cleanedNotes: normalized, eventLocation: undefined as SpecialDateEvent['eventLocation'] };
    }

    const originalIndex = lines.length - 1 - metadataLineIndex;
    const metadataLine = lines[originalIndex].slice(EVENT_LOCATION_METADATA_PREFIX.length).trim();
    let eventLocation: SpecialDateEvent['eventLocation'];

    try {
      const parsed = JSON.parse(metadataLine) as Partial<{
        placeId: string;
        formattedAddress: string;
        line1: string;
        city: string;
        state: string;
        zip: string;
        phone: string;
      }>;
      eventLocation = {
        placeId: parsed.placeId ? String(parsed.placeId) : undefined,
        formattedAddress: parsed.formattedAddress ? String(parsed.formattedAddress) : undefined,
        line1: parsed.line1 ? String(parsed.line1) : '',
        city: parsed.city ? String(parsed.city) : '',
        state: parsed.state ? String(parsed.state) : '',
        zip: parsed.zip ? String(parsed.zip) : '',
        phone: parsed.phone ? String(parsed.phone) : undefined,
      };
    } catch {
      eventLocation = undefined;
    }

    const cleanedLines = lines.filter((_, index) => index !== originalIndex);
    const cleanedNotes = cleanedLines.join('\n').trim();
    return {
      cleanedNotes: cleanedNotes || undefined,
      eventLocation,
    };
  };

  const notesFromApi = event.notes ?? undefined;
  const parsedNotesMetadata = parseEventLocationNotesMetadata(notesFromApi);
  const eventLocation = event?.eventLocation && typeof event.eventLocation === 'object'
    ? {
        placeId: event.eventLocation.placeId ? String(event.eventLocation.placeId) : undefined,
        formattedAddress: event.eventLocation.formattedAddress ? String(event.eventLocation.formattedAddress) : undefined,
        line1: event.eventLocation.line1 ? String(event.eventLocation.line1) : '',
        city: event.eventLocation.city ? String(event.eventLocation.city) : '',
        state: event.eventLocation.state ? String(event.eventLocation.state) : '',
        zip: event.eventLocation.zip ? String(event.eventLocation.zip) : '',
        phone: event.eventLocation.phone ? String(event.eventLocation.phone) : undefined,
      }
    : undefined;

  return {
    id: String(event.id),
    title: String(event.title),
    people: String(event.people),
    ageAsOfToday: event.ageAsOfToday === undefined || event.ageAsOfToday === null
      ? undefined
      : Number(event.ageAsOfToday),
    eventDateTime: new Date(event.eventDateTime).toISOString(),
    reminderDateTime: new Date(event.reminderDateTime).toISOString(),
    reminderTimeZone: event.reminderTimeZone ? String(event.reminderTimeZone) : undefined,
    eventAllDay: Boolean(event.eventAllDay),
    reminderAllDay: Boolean(event.reminderAllDay),
    frequency: event.frequency,
    reminderMode: event.reminderMode ?? undefined,
    notes: parsedNotesMetadata.cleanedNotes,
    eventLocation: eventLocation || parsedNotesMetadata.eventLocation,
    notified: event.notified ?? undefined,
    lastReminderTriggeredAt: event.lastReminderTriggeredAt ? new Date(event.lastReminderTriggeredAt).toISOString() : undefined,
    variableReminders: Array.isArray(event.reminders)
      ? event.reminders.map((entry: any) => ({
          id: String(entry.id),
          reminderDateTime: new Date(entry.reminderDateTime).toISOString(),
          notes: entry.notes ?? undefined,
        }))
      : Array.isArray(event.variableReminders)
      ? event.variableReminders
      : undefined,
  };
}

function stripEventLocationNotesMetadata(value: string | undefined) {
  const normalized = String(value || '');
  if (!normalized.trim()) {
    return '';
  }

  return normalized
    .split('\n')
    .filter((line) => !line.startsWith(EVENT_LOCATION_METADATA_PREFIX))
    .join('\n')
    .trim();
}

function serializeEventsForApi(events: SpecialDateEvent[]) {
  return events.map((event) => {
    const cleanNotes = stripEventLocationNotesMetadata(event.notes);

    if (!event.eventLocation) {
      return {
        ...event,
        notes: cleanNotes || undefined,
      };
    }

    const locationMetadata = `${EVENT_LOCATION_METADATA_PREFIX}${JSON.stringify(event.eventLocation)}`;
    const encodedNotes = cleanNotes ? `${cleanNotes}\n${locationMetadata}` : locationMetadata;

    return {
      ...event,
      notes: encodedNotes,
    };
  });
}

function shouldPruneExpiredNonYearlyEvent(event: SpecialDateEvent, nowMs: number) {
  const normalizedTitle = String(event.title || '').trim().toLowerCase();
  const isBirthdayOrAnniversary = normalizedTitle.includes('birthday') || normalizedTitle.includes('anniversary');

  if (isBirthdayOrAnniversary) {
    return false;
  }

  if (event.frequency === 'yearly') {
    return false;
  }

  const eventTime = new Date(event.eventDateTime).getTime();
  if (!Number.isFinite(eventTime)) {
    return false;
  }

  return eventTime < nowMs;
}

function pruneExpiredNonYearlyEvents(events: SpecialDateEvent[]) {
  const nowMs = Date.now();
  return events.filter((event) => !shouldPruneExpiredNonYearlyEvent(event, nowMs));
}

export function isApiStorageEnabled() {
  return USE_API_STORAGE;
}

export async function isApiReachable(timeoutMs = 7000): Promise<boolean> {
  if (!USE_API_STORAGE) {
    return false;
  }

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function loadReminderSoundSettings(userId?: string): Promise<ReminderSoundSettings> {
  try {
    const raw = await AsyncStorage.getItem(getReminderSoundSettingsKey(userId));
    return parseReminderSoundSettings(raw);
  } catch (error) {
    console.warn('Failed to load reminder sound settings; using defaults.', error);
    return defaultReminderSoundSettings;
  }
}

export async function saveReminderSoundSettings(settings: ReminderSoundSettings, userId?: string) {
  try {
    await AsyncStorage.setItem(getReminderSoundSettingsKey(userId), JSON.stringify(settings));
  } catch (error) {
    console.warn('Failed to save reminder sound settings.', error);
  }
}

export async function loadReminderDeliverySettings(userId?: string): Promise<ReminderDeliverySettings> {
  try {
    const raw = await AsyncStorage.getItem(getReminderDeliverySettingsKey(userId));
    return parseReminderDeliverySettings(raw);
  } catch (error) {
    console.warn('Failed to load reminder delivery settings; using defaults.', error);
    return defaultReminderDeliverySettings;
  }
}

export async function saveReminderDeliverySettings(settings: ReminderDeliverySettings, userId?: string) {
  const nextSettings: ReminderDeliverySettings = {
    device: Boolean(settings.device),
    email: Boolean(settings.email),
    text: false,
  };

  try {
    await AsyncStorage.setItem(getReminderDeliverySettingsKey(userId), JSON.stringify(nextSettings));
  } catch (error) {
    console.warn('Failed to save reminder delivery settings.', error);
  }
}

export async function loadReminderDefaultTimeSettings(userId?: string): Promise<ReminderDefaultTimeSettings> {
  try {
    const raw = await AsyncStorage.getItem(getReminderDefaultTimeSettingsKey(userId));
    return parseReminderDefaultTimeSettings(raw);
  } catch (error) {
    console.warn('Failed to load reminder default time settings; using defaults.', error);
    return defaultReminderDefaultTimeSettings;
  }
}

export async function saveReminderDefaultTimeSettings(settings: ReminderDefaultTimeSettings, userId?: string) {
  const nextSettings: ReminderDefaultTimeSettings = {
    hour: Math.max(0, Math.min(23, Math.trunc(settings.hour))),
    minute: Math.max(0, Math.min(59, Math.trunc(settings.minute))),
  };

  try {
    await AsyncStorage.setItem(getReminderDefaultTimeSettingsKey(userId), JSON.stringify(nextSettings));
  } catch (error) {
    console.warn('Failed to save reminder default time settings.', error);
  }
}

export async function loadReminderTimeZoneSettings(userId?: string): Promise<ReminderTimeZoneSettings> {
  try {
    const raw = await AsyncStorage.getItem(getReminderTimeZoneSettingsKey(userId));
    return parseReminderTimeZoneSettings(raw);
  } catch (error) {
    console.warn('Failed to load reminder time zone settings; using defaults.', error);
    return defaultReminderTimeZoneSettings;
  }
}

export async function saveReminderTimeZoneSettings(settings: ReminderTimeZoneSettings, userId?: string) {
  const nextSettings: ReminderTimeZoneSettings = {
    timeZone: typeof settings.timeZone === 'string' && settings.timeZone.trim()
      ? settings.timeZone.trim()
      : defaultReminderTimeZoneSettings.timeZone,
  };

  try {
    await AsyncStorage.setItem(getReminderTimeZoneSettingsKey(userId), JSON.stringify(nextSettings));
  } catch (error) {
    console.warn('Failed to save reminder time zone settings.', error);
  }
}

export async function loadCalendarSyncSettings(userId?: string): Promise<CalendarSyncSettings> {
  try {
    const raw = await AsyncStorage.getItem(getCalendarSyncSettingsKey(userId));
    return parseCalendarSyncSettings(raw);
  } catch (error) {
    console.warn('Failed to load calendar sync settings; using defaults.', error);
    return defaultCalendarSyncSettings;
  }
}

export async function saveCalendarSyncSettings(settings: CalendarSyncSettings, userId?: string) {
  const normalizedProvider: CalendarSyncProvider = settings.provider === 'google' || settings.provider === 'outlook' || settings.provider === 'apple'
    ? settings.provider
    : 'none';

  const nextSettings: CalendarSyncSettings = {
    provider: normalizedProvider,
    google: {
      calendarId: typeof settings.google?.calendarId === 'string' ? settings.google.calendarId.trim() : '',
      permission: settings.google?.permission === 'write' || settings.google?.permission === 'read'
        ? settings.google.permission
        : 'write',
      syncPaused: settings.google?.syncPaused === true,
    },
    outlook: {
      email: typeof settings.outlook?.email === 'string' ? settings.outlook.email.trim() : '',
      syncPaused: settings.outlook?.syncPaused === true,
    },
    apple: {
      appleId: typeof settings.apple?.appleId === 'string' ? settings.apple.appleId.trim() : '',
      calendarName: typeof settings.apple?.calendarName === 'string' ? settings.apple.calendarName.trim() : '',
      syncPaused: settings.apple?.syncPaused === true,
    },
  };

  try {
    await AsyncStorage.setItem(getCalendarSyncSettingsKey(userId), JSON.stringify(nextSettings));
  } catch (error) {
    console.warn('Failed to save calendar sync settings.', error);
  }
}

export async function getGoogleAuthorizationConnectUrl(userId: string, permission: CalendarSyncPermission, googleId: string): Promise<GoogleOAuthConnectUrlResult> {
  try {
    const returnUrl = getRuntimeAppReturnUrl();
    const response = await apiRequest<GoogleOAuthConnectUrlResult>('/calendar-sync/google/connect-url', {
      method: 'POST',
      body: JSON.stringify({ userId, permission, googleId, returnUrl }),
    });
    return response;
  } catch (error) {
    return {
      success: false,
      authUrl: '',
    };
  }
}

export async function getGoogleConnectionStatus(userId: string): Promise<GoogleOAuthConnectionStatusResult> {
  try {
    return await apiRequest<GoogleOAuthConnectionStatusResult>(`/calendar-sync/google/status?userId=${encodeURIComponent(userId)}`);
  } catch {
    return { connected: false };
  }
}

export async function getOutlookAuthorizationConnectUrl(userId: string, email: string): Promise<OutlookOAuthConnectUrlResult> {
  try {
    const returnUrl = getRuntimeAppReturnUrl();
    const response = await apiRequest<OutlookOAuthConnectUrlResult>('/calendar-sync/outlook/connect-url', {
      method: 'POST',
      body: JSON.stringify({ userId, email, returnUrl }),
    });
    return response;
  } catch {
    return {
      success: false,
      authUrl: '',
    };
  }
}

export async function getOutlookConnectionStatus(userId: string): Promise<OutlookOAuthConnectionStatusResult> {
  try {
    return await apiRequest<OutlookOAuthConnectionStatusResult>(`/calendar-sync/outlook/status?userId=${encodeURIComponent(userId)}`);
  } catch {
    return { connected: false };
  }
}

export async function disconnectGoogleCalendarConnection(userId: string): Promise<boolean> {
  try {
    await apiRequest<{ success: boolean }>('/calendar-sync/google/disconnect', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectOutlookCalendarConnection(userId: string): Promise<boolean> {
  try {
    await apiRequest<{ success: boolean }>('/calendar-sync/outlook/disconnect', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function createShareInvite(
  senderUserId: string,
  recipientUserId: string,
  sourceEventId: string,
  message: string,
  channels: string[],
): Promise<boolean> {
  if (!USE_API_STORAGE) {
    return false;
  }

  try {
    await apiRequest<{ success: boolean }>('/shares/invite', {
      method: 'POST',
      body: JSON.stringify({
        senderUserId,
        recipientUserId,
        sourceEventId,
        message,
        channels,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadPendingShareInvites(userId: string): Promise<PendingShareInvite[]> {
  if (!USE_API_STORAGE || !userId) {
    return [];
  }

  try {
    const response = await apiRequest<PendingShareInvitesResult>(`/shares/pending?userId=${encodeURIComponent(userId)}`);
    return Array.isArray(response.invites)
      ? response.invites.map((invite) => ({
          ...invite,
          createdAt: new Date(invite.createdAt).toISOString(),
          sourceEvent: {
            ...invite.sourceEvent,
            eventDateTime: new Date(invite.sourceEvent.eventDateTime).toISOString(),
            reminderDateTime: new Date(invite.sourceEvent.reminderDateTime).toISOString(),
            variableReminders: invite.sourceEvent.variableReminders,
          },
        }))
      : [];
  } catch (error) {
    console.warn('loadPendingShareInvites failed', error);
    throw error;
  }
}

export async function respondToShareInvite(
  userId: string,
  inviteId: string,
  action: 'accept' | 'dismiss',
): Promise<{ success: boolean; accepted?: boolean; duplicate?: boolean }> {
  if (!USE_API_STORAGE || !userId || !inviteId) {
    return { success: false };
  }

  try {
    return await apiRequest<{ success: boolean; accepted?: boolean; duplicate?: boolean }>('/shares/respond', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        inviteId,
        action,
      }),
    });
  } catch {
    return { success: false };
  }
}

export async function pushGoogleCalendarEvents(userId: string): Promise<GoogleCalendarPushResult> {
  if (!USE_API_STORAGE || !userId) {
    return {
      success: false,
      created: 0,
      updated: 0,
      failed: 0,
      errors: ['Cloud API mode is required for Google Calendar push.'],
    };
  }

  const syncSettings = await loadCalendarSyncSettings(userId);
  const googleConfig = syncSettings.google;
  if (googleConfig.syncPaused) {
    return {
      success: false,
      created: 0,
      updated: 0,
      failed: 0,
      errors: ['Google Calendar sync is paused. Resume sync before pushing events.'],
    };
  }

  if (googleConfig.permission !== 'write') {
    return {
      success: false,
      created: 0,
      updated: 0,
      failed: 0,
      errors: ['Google Calendar sync permission must be set to Read & Write for push.'],
    };
  }

  const events = await loadEvents(userId);
  if (!events.length) {
    return {
      success: true,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };
  }

  try {
    const response = await apiRequest<GoogleCalendarPushResult>('/calendar-sync/google/push', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        calendarId: googleConfig.calendarId || undefined,
        events,
      }),
    });
    return response;
  } catch (error) {
    return {
      success: false,
      created: 0,
      updated: 0,
      failed: events.length,
      errors: [error instanceof Error ? error.message : 'Google Calendar push failed.'],
    };
  }
}

export async function sendReminderEmailNotification(userId: string | undefined, payload: {
  eventId: string;
  eventTitle: string;
  people: string;
  eventDateTime: string;
  eventAllDay: boolean;
  reminderDateTime: string;
  notes?: string;
}) {
  if (!USE_API_STORAGE || !userId) {
    return false;
  }

  try {
    await apiRequest<{ success: boolean }>('/notifications/reminder-email', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        ...payload,
      }),
    });
    return true;
  } catch (error) {
    console.warn('Reminder email notification failed', error);
    return false;
  }
}

export async function sendReminderSmsNotification(userId: string | undefined, payload: {
  eventId: string;
  eventTitle: string;
  people: string;
  eventDateTime: string;
  eventAllDay: boolean;
  notes?: string;
}) {
  if (!USE_API_STORAGE || !userId) {
    return false;
  }

  try {
    await apiRequest<{ success: boolean }>('/notifications/reminder-sms', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        ...payload,
      }),
    });
    return true;
  } catch (error) {
    console.warn('Reminder SMS notification failed', error);
    return false;
  }
}

export async function sendShareEmailNotification(payload: {
  toEmail: string;
  subject: string;
  body: string;
  htmlBody?: string;
}) {
  try {
    await apiRequest<{ success: boolean }>('/notifications/share-email', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return true;
  } catch (error) {
    console.warn('Share email notification failed', error);
    return false;
  }
}

export async function sendContactSupportMessage(payload: {
  userId?: string;
  userEmail?: string;
  subject: string;
  message: string;
}) {
  if (!USE_API_STORAGE) {
    return { success: false, error: 'Support messaging requires API mode.' };
  }

  const supportEndpoints = ['/notifications/contact-support', '/notifications/support-email'];
  const rawFallbackSupportEmail = String(
    (typeof process !== 'undefined' && process.env && (process.env.EXPO_PUBLIC_SUPPORT_EMAIL || process.env.SUPPORT_EMAIL)) || '',
  ).trim();
  const fallbackSupportEmail = rawFallbackSupportEmail.replace(/^['\"]+|['\"]+$/g, '').trim();

  try {
    for (const endpoint of supportEndpoints) {
      try {
        await apiRequest<{ success: boolean }>(endpoint, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';
        if (errorMessage.includes('status 404')) {
          continue;
        }

        return {
          success: false,
          error: errorMessage || 'Unable to send support message right now.',
        };
      }
    }

    if (fallbackSupportEmail) {
      const textBody = [
        'Special Date Reminder support request',
        '',
        `Subject: ${payload.subject}`,
        `User email: ${payload.userEmail || 'not provided'}`,
        `User ID: ${payload.userId || 'not provided'}`,
        '',
        payload.message,
      ].join('\n');

      await apiRequest<{ success: boolean }>('/notifications/share-email', {
        method: 'POST',
        body: JSON.stringify({
          toEmail: fallbackSupportEmail,
          subject: `Support request: ${payload.subject}`,
          body: textBody,
        }),
      });

      return { success: true };
    }

    return {
      success: false,
      error: 'Support email endpoint was not found on the server (404). Set EXPO_PUBLIC_SUPPORT_EMAIL to enable fallback delivery.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unable to send support message right now.',
    };
  }
}

export async function migrateLocalUsersAndEventsToApi() {
  if (!USE_API_STORAGE) {
    return { skipped: true, reason: 'api-storage-disabled' as const, usersMigrated: 0, eventsMigrated: 0 };
  }

  const alreadyMigrated = await AsyncStorage.getItem(API_MIGRATION_KEY);
  const localUsers = await readStoredUsers();

  if (alreadyMigrated === 'true') {
    if (!localUsers.length) {
      return { skipped: true, reason: 'already-migrated' as const, usersMigrated: 0, eventsMigrated: 0 };
    }

    try {
      const count = await apiRequest<{ userCount: number }>('/admin/user-count');
      if (count.userCount > 0) {
        return { skipped: true, reason: 'already-migrated' as const, usersMigrated: 0, eventsMigrated: 0 };
      }
    } catch {
      return { skipped: true, reason: 'already-migrated' as const, usersMigrated: 0, eventsMigrated: 0 };
    }
  }

  let usersMigrated = 0;
  let eventsMigrated = 0;
  let hadFailure = false;

  for (const localUser of localUsers) {
    try {
      let apiUser: StoredUser | null = null;

      try {
        const signInResponse = await apiRequest<{ user: StoredUser }>('/auth/signin', {
          method: 'POST',
          body: JSON.stringify({ email: localUser.email, password: localUser.password }),
        });
        apiUser = signInResponse.user;
      } catch {
        try {
          const signUpResponse = await apiRequest<{ user: StoredUser }>('/auth/signup', {
            method: 'POST',
            body: JSON.stringify({
              email: localUser.email,
              password: localUser.password,
              mobileNumber: localUser.mobileNumber,
              fullName: localUser.fullName,
              address: localUser.address,
              birthDate: localUser.birthDate,
            }),
          });
          apiUser = signUpResponse.user;
        } catch {
          hadFailure = true;
          continue;
        }
      }

      if (!apiUser) {
        hadFailure = true;
        continue;
      }

      usersMigrated += 1;

      const localEvents = await readStoredEvents(getUserStorageKey(localUser.id));

      if (localEvents.length) {
        await apiRequest<{ success: boolean }>(`/users/${encodeURIComponent(apiUser.id)}/events`, {
          method: 'PUT',
          body: JSON.stringify({ events: serializeEventsForApi(localEvents) }),
        });
        eventsMigrated += localEvents.length;
      }
    } catch {
      hadFailure = true;
    }
  }

  if (!hadFailure) {
    await AsyncStorage.setItem(API_MIGRATION_KEY, 'true');
  }

  return {
    skipped: false,
    usersMigrated,
    eventsMigrated,
    hadFailure,
  };
}

export async function loadEvents(userId?: string): Promise<SpecialDateEvent[]> {
  if (USE_API_STORAGE && userId) {
    try {
      const response = await apiRequest<{ events: any[] }>(`/users/${encodeURIComponent(userId)}/events`);
      const mappedEvents = response.events.map(mapApiEventToLocal);
      const prunedEvents = pruneExpiredNonYearlyEvents(mappedEvents);
      if (prunedEvents.length !== mappedEvents.length) {
        try {
          await apiRequest<{ success: boolean }>(`/users/${encodeURIComponent(userId)}/events`, {
            method: 'PUT',
            body: JSON.stringify({ events: prunedEvents }),
          });
        } catch (error) {
          console.warn('Unable to persist expired event cleanup to API storage.', error);
        }
      }
      setApiStorageStatusMessage(null);
      return prunedEvents;
    } catch (error) {
      console.warn('API loadEvents failed; falling back to local storage.', error);
      setApiStorageStatusMessage('Cloud sync unavailable. Using local storage for now.');
    }
  }

  const storageKey = userId ? getUserStorageKey(userId) : STORAGE_KEY;
  const storedEvents = await readStoredEvents(storageKey);
  const prunedEvents = pruneExpiredNonYearlyEvents(storedEvents);
  if (prunedEvents.length !== storedEvents.length) {
    await AsyncStorage.setItem(storageKey, JSON.stringify(prunedEvents));
  }

  return prunedEvents;
}

export async function saveEvents(events: SpecialDateEvent[], userId?: string): Promise<void> {
  const prunedEvents = pruneExpiredNonYearlyEvents(events);

  if (USE_API_STORAGE && userId) {
    try {
      await apiRequest<{ success: boolean }>(`/users/${encodeURIComponent(userId)}/events`, {
        method: 'PUT',
        body: JSON.stringify({ events: serializeEventsForApi(prunedEvents) }),
      });
      setApiStorageStatusMessage(null);
      return;
    } catch (error) {
      console.warn('API saveEvents failed; writing to local storage fallback.', error);
      setApiStorageStatusMessage('Cloud sync unavailable. Changes are saved locally until backend returns.');
    }
  }

  const storageKey = userId ? getUserStorageKey(userId) : STORAGE_KEY;
  await AsyncStorage.setItem(storageKey, JSON.stringify(prunedEvents));
}

export function validateEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validatePassword(value: string) {
  if (value.length < 8) {
    return 'Password must be at least 8 characters long.';
  }

  if (!/[A-Z]/.test(value)) {
    return 'Password must include at least one capital letter.';
  }

  if (!/\d/.test(value)) {
    return 'Password must include at least one number.';
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) {
    return 'Password must include at least one special character.';
  }

  return null;
}

export function normalizePhoneNumber(value: string) {
  return value.replace(/\D/g, '').slice(0, 10);
}

export function validatePhoneNumber(value: string) {
  const digits = normalizePhoneNumber(value);

  if (digits.length !== 10) {
    return 'Please enter a valid 10-digit mobile phone number.';
  }

  const areaCode = digits.slice(0, 3);
  const exchange = digits.slice(3, 6);

  if (/^[01]/.test(areaCode) || /^[01]/.test(exchange)) {
    return 'The area code and exchange must not start with 0 or 1.';
  }

  return null;
}

export function validateBirthDate(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return 'Please enter your birth date.';
  }

  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(normalized)) {
    return 'Please enter your birth date in mm/dd/yyyy format.';
  }

  const [monthStr, dayStr, yearStr] = normalized.split('/');
  const month = Number(monthStr);
  const day = Number(dayStr);
  const year = Number(yearStr);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return 'Please enter a valid date in mm/dd/yyyy format.';
  }

  return null;
}

export async function createUser(email: string, password: string, mobileNumber?: string, fullName?: string, address?: string, birthDate?: string): Promise<CreateUserResult> {
  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser; verificationRequired?: boolean; message?: string }>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password, mobileNumber, fullName, address, birthDate }),
      });
      return {
        user: response.user,
        verificationRequired: Boolean(response.verificationRequired),
        message: response.message,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to create account.' };
    }
  }

  const users = await readStoredUsers();

  if (users.some((user) => user.email.toLowerCase() === email.toLowerCase())) {
    return { error: 'An account with that email already exists.' };
  }

  if (mobileNumber !== undefined) {
    const phoneError = validatePhoneNumber(mobileNumber);
    if (phoneError) {
      return { error: phoneError };
    }
  }

  const user: StoredUser = {
    id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    email,
    password,
    mobileNumber: mobileNumber ? normalizePhoneNumber(mobileNumber) : undefined,
    fullName: fullName?.trim() || undefined,
    address: address?.trim() || undefined,
    birthDate: birthDate?.trim() || undefined,
  };

  const nextUsers = [...users, user];
  await AsyncStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
  return { user };
}

export async function signInUser(email: string, password: string): Promise<SignInResult> {
  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser }>('/auth/signin', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      return { user: response.user };
    } catch (error) {
      return {
        user: null,
        error: error instanceof Error ? error.message : 'Unable to sign in.',
      };
    }
  }

  const users = await readStoredUsers();
  const user = users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());

  if (!user || user.password !== password) {
    return { user: null, error: 'invalid credentials' };
  }

  return { user };
}

export async function resetPassword(email: string) {
  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ temporaryPassword: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return response.temporaryPassword;
    } catch {
      return null;
    }
  }

  const users = await readStoredUsers();
  const user = users.find((entry) => entry.email.toLowerCase() === email.toLowerCase());

  if (!user) {
    return null;
  }

  const temporaryPassword = `Temp${Date.now().toString().slice(-6)}!A`;
  const nextUsers = users.map((entry) => entry.id === user.id ? { ...entry, password: temporaryPassword } : entry);
  await AsyncStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
  return temporaryPassword;
}

export async function resendVerificationEmail(email: string): Promise<ResendVerificationResult> {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return { success: false, error: 'Please enter your email address first.' };
  }

  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ success: boolean; message?: string }>('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail }),
      });

      return {
        success: Boolean(response.success),
        message: response.message,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unable to resend verification email.',
      };
    }
  }

  return {
    success: false,
    error: 'Resend verification is only available when API storage is enabled.',
  };
}

export async function loadUser(userId: string) {
  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser }>(`/users/${encodeURIComponent(userId)}`);
      return response.user;
    } catch {
      return null;
    }
  }

  const users = await readStoredUsers();
  return users.find((entry) => entry.id === userId) || null;
}

export async function findUserByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser | null }>(`/users/find-by-email?email=${encodeURIComponent(normalizedEmail)}`);
      return response.user || null;
    } catch {
      // Ignore API lookup failures and fall back to local data.
    }
  }

  const users = await readStoredUsers();
  return users.find((entry) => entry.email.toLowerCase() === normalizedEmail) || null;
}

export async function findUserByPhone(phone: string) {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (!normalizedPhone) {
    return null;
  }

  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser | null }>(`/users/find-by-phone?phone=${encodeURIComponent(normalizedPhone)}`);
      return response.user || null;
    } catch {
      // Ignore API lookup failures and fall back to local data.
    }
  }

  const users = await readStoredUsers();
  return users.find((entry) => normalizePhoneNumber(entry.mobileNumber || '') === normalizedPhone) || null;
}

export async function findGoogleAddressPredictions(input: string, sessionToken?: string): Promise<GoogleAddressPrediction[]> {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return [];
  }

  try {
    const params = new URLSearchParams({ input: normalizedInput });
    if (sessionToken?.trim()) {
      params.set('sessionToken', sessionToken.trim());
    }
    const regionCode = resolveRuntimeRegionCode();
    if (regionCode) {
      params.set('regionCode', regionCode);
    }

    const response = await apiRequest<{ predictions: GoogleAddressPrediction[] }>(`/google/places/autocomplete?${params.toString()}`);
    return Array.isArray(response.predictions) ? response.predictions : [];
  } catch (error) {
    console.warn('Google address autocomplete failed', error);
    return [];
  }
}

export async function resolveGoogleAddressPrediction(placeId: string, sessionToken?: string): Promise<GoogleResolvedAddress | null> {
  const normalizedPlaceId = placeId.trim();
  if (!normalizedPlaceId) {
    return null;
  }

  try {
    const params = new URLSearchParams({ placeId: normalizedPlaceId });
    if (sessionToken?.trim()) {
      params.set('sessionToken', sessionToken.trim());
    }

    const response = await apiRequest<{ address: GoogleResolvedAddress }>(`/google/places/details?${params.toString()}`);
    return response.address || null;
  } catch (error) {
    console.warn('Google address details lookup failed', error);
    return null;
  }
}

export async function updateUserProfile(userId: string, updates: Partial<Pick<StoredUser, 'mobileNumber' | 'fullName' | 'address' | 'birthDate'>>) {
  if (USE_API_STORAGE) {
    try {
      const response = await apiRequest<{ user: StoredUser }>(`/users/${encodeURIComponent(userId)}/profile`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      return { user: response.user };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to update profile.' };
    }
  }

  const users = await readStoredUsers();
  const index = users.findIndex((entry) => entry.id === userId);

  if (index === -1) {
    return { error: 'User not found.' };
  }

  const updatedUser = { ...users[index], ...updates };
  users[index] = updatedUser;
  await AsyncStorage.setItem(USERS_KEY, JSON.stringify(users));
  return { user: updatedUser };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  if (USE_API_STORAGE) {
    try {
      await apiRequest<{ success: boolean }>(`/users/${encodeURIComponent(userId)}/change-password`, {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const user = await loadUser(userId);
      return user ? { user } : { error: 'User not found.' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to change password.' };
    }
  }

  const users = await readStoredUsers();
  const index = users.findIndex((entry) => entry.id === userId);

  if (index === -1) {
    return { error: 'User not found.' };
  }

  if (users[index].password !== currentPassword) {
    return { error: 'The current password is incorrect.' };
  }

  users[index] = { ...users[index], password: newPassword };
  await AsyncStorage.setItem(USERS_KEY, JSON.stringify(users));
  return { user: users[index] };
}

export async function deleteUser(userId: string) {
  if (USE_API_STORAGE) {
    try {
      await apiRequest<{ success: boolean }>(`/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  const users = await readStoredUsers();
  const nextUsers = users.filter((entry) => entry.id !== userId);
  await AsyncStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
  await AsyncStorage.removeItem(`${STORAGE_KEY}:${userId}`);
  return { success: true };
}
