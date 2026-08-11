export type ReminderFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'once';

export interface VariableReminderEntry {
  id: string;
  reminderDateTime: string;
  notes?: string;
}

export interface EventLocationAddress {
  placeId?: string;
  formattedAddress?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
}

export interface SpecialDateEvent {
  id: string;
  title: string;
  people: string;
  ageAsOfToday?: number;
  eventDateTime: string;
  eventEndDateTime?: string;
  reminderDateTime: string;
  reminderTimeZone?: string;
  eventAllDay: boolean;
  reminderAllDay: boolean;
  frequency: ReminderFrequency;
  reminderMode?: 'none' | 'static' | 'variable';
  notes?: string;
  eventLocation?: EventLocationAddress;
  notified?: boolean;
  lastReminderTriggeredAt?: string;
  variableReminders?: VariableReminderEntry[];
}
