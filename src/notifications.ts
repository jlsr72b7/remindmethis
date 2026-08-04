import * as Notifications from 'expo-notifications';

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
    const { status } = await Notifications.requestPermissionsAsync();
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

    await Promise.race([
      Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date,
        },
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Notification scheduling timed out')), 1500);
      }),
    ]);

    return true;
  } catch (error) {
    console.warn('Reminder scheduling failed', error);
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
