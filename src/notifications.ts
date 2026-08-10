import * as Notifications from 'expo-notifications';

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

    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date,
      },
    });

    return true;
  } catch (error) {
    console.warn('Reminder scheduling failed', error);
    return false;
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
