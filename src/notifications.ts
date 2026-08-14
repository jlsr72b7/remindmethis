import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

type AudioContextConstructor = new () => {
  state: string;
  currentTime: number;
  destination: AudioNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
  close: () => Promise<void>;
};

export type ReminderPingPattern = 'single' | 'double';
export type ReminderPingVolume = 'normal' | 'loud';

export async function requestNotificationPermission() {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return status === 'granted';
  } catch (error) {
    console.warn('Notification permission request failed', error);
    return false;
  }
}

export async function scheduleReminder(title: string, body: string, date: Date) {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    if (typeof Notifications.scheduleNotificationAsync !== 'function') {
      return false;
    }

    const permission = await Notifications.getPermissionsAsync();
    if (permission.status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
      if (requested.status !== 'granted') {
        return false;
      }
    }

    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        interruptionLevel: 'timeSensitive',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date,
      },
    });

    console.log('local reminder scheduled', {
      notificationId,
      scheduledFor: date.toISOString(),
      permissionStatus: permission.status,
      iosStatus: permission.ios?.status ?? null,
    });

    return true;
  } catch (error) {
    console.warn('Reminder scheduling failed', error);
    return false;
  }
}

export async function getNotificationDiagnostics() {
  if (Platform.OS === 'web') {
    return {
      platform: Platform.OS,
      permissionStatus: 'unsupported',
      iosStatus: null,
      scheduledCount: 0,
      nextScheduledAt: null as string | null,
    };
  }

  try {
    const [permission, scheduled] = await Promise.all([
      Notifications.getPermissionsAsync(),
      Notifications.getAllScheduledNotificationsAsync(),
    ]);

    const safeStringify = (value: unknown) => {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const triggerSamples = scheduled.slice(0, 5).map((item) => ({
      id: item.identifier,
      trigger: safeStringify(item.trigger),
      title: item.content.title,
    }));

    const resolveTriggerTimeMs = (trigger: unknown): number | null => {
      if (!trigger || typeof trigger !== 'object') {
        return null;
      }

      const candidate = trigger as {
        date?: Date | number | string;
        value?: Date | number | string;
        dateComponents?: {
          year?: number;
          month?: number;
          day?: number;
          hour?: number;
          minute?: number;
          second?: number;
        };
      };

      const direct = candidate.date ?? candidate.value;
      if (direct !== undefined && direct !== null) {
        const directMs = new Date(direct).getTime();
        if (Number.isFinite(directMs)) {
          return directMs;
        }
      }

      const parts = candidate.dateComponents;
      if (!parts) {
        return null;
      }

      if (
        typeof parts.year === 'number'
        && typeof parts.month === 'number'
        && typeof parts.day === 'number'
        && typeof parts.hour === 'number'
        && typeof parts.minute === 'number'
      ) {
        const componentMs = new Date(
          parts.year,
          parts.month - 1,
          parts.day,
          parts.hour,
          parts.minute,
          parts.second || 0,
          0,
        ).getTime();
        return Number.isFinite(componentMs) ? componentMs : null;
      }

      return null;
    };

    const nextTriggerCandidates = await Promise.all(scheduled.map(async (item) => {
      const trigger = item.trigger as Notifications.SchedulableNotificationTriggerInput | null;

      if (trigger) {
        try {
          const next = await Notifications.getNextTriggerDateAsync(trigger);
          if (typeof next === 'number' && Number.isFinite(next)) {
            return next;
          }
        } catch {
          // Fall back to local trigger parsing below.
        }
      }

      return resolveTriggerTimeMs(item.trigger);
    }));

    const nextTriggerMs = nextTriggerCandidates
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0] ?? null;

    return {
      platform: Platform.OS,
      permissionStatus: permission.status,
      iosStatus: permission.ios?.status ?? null,
      allowsAlert: permission.ios?.allowsAlert ?? null,
      allowsSound: permission.ios?.allowsSound ?? null,
      allowsBadge: permission.ios?.allowsBadge ?? null,
      scheduledCount: scheduled.length,
      nextScheduledAt: nextTriggerMs ? new Date(nextTriggerMs).toISOString() : null,
      triggerSamples,
    };
  } catch (error) {
    return {
      platform: Platform.OS,
      permissionStatus: 'error',
      iosStatus: null,
      scheduledCount: 0,
      nextScheduledAt: null as string | null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function clearScheduledReminders() {
  try {
    if (typeof Notifications.cancelAllScheduledNotificationsAsync !== 'function') {
      return false;
    }

    await Notifications.cancelAllScheduledNotificationsAsync();
    return true;
  } catch (error) {
    console.warn('Clearing scheduled reminders failed', error);
    return false;
  }
}

export async function playReminderPing(options?: { pattern?: ReminderPingPattern; volume?: ReminderPingVolume }) {
  try {
    const pattern = options?.pattern === 'double' ? 'double' : 'single';
    const volume = options?.volume === 'loud' ? 0.16 : 0.08;
    const audioGlobal = globalThis as unknown as {
      AudioContext?: AudioContextConstructor;
      webkitAudioContext?: AudioContextConstructor;
    };
    const Context = audioGlobal.AudioContext || audioGlobal.webkitAudioContext;

    if (!Context) {
      return false;
    }

    const context = new Context();
    if (context.state === 'suspended') {
      await context.resume();
    }

    const pulseOffsets = pattern === 'double' ? [0, 0.22] : [0];
    const pulseDuration = 0.18;

    pulseOffsets.forEach((offset, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime + offset;

      oscillator.type = 'sine';
      oscillator.frequency.value = index === 0 ? 1046 : 1318;

      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + pulseDuration);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(startAt);
      oscillator.stop(startAt + pulseDuration);
    });

    const totalDurationMs = Math.ceil((pulseOffsets[pulseOffsets.length - 1] + pulseDuration + 0.1) * 1000);
    setTimeout(() => {
      void context.close();
    }, totalDurationMs);

    return true;
  } catch (error) {
    console.warn('Reminder ping failed', error);
    return false;
  }
}
