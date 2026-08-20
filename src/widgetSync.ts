export const WIDGET_APP_GROUP_ID = 'group.com.example.specialdatereminder';
export const WIDGET_DATA_KEY = 'widgetSyncPayload';

export interface WidgetNextEvent {
  title: string;
  people: string;
  dateLabel: string;
}

export interface WidgetNextReminder {
  title: string;
  people: string;
  eventDateLabel: string;
  reminderDateLabel: string;
}

export interface WidgetSyncPayload {
  nextEvent: WidgetNextEvent | null;
  nextReminder: WidgetNextReminder | null;
  updatedAt: string;
}
