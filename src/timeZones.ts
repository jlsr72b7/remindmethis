export const getDeviceTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
];

export const getSupportedTimeZones = () => {
  try {
    const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supportedValuesOf === 'function') {
      const zones = supportedValuesOf('timeZone');
      if (zones.length) {
        return zones;
      }
    }
  } catch {
    // Ignore and use fallback list.
  }

  return FALLBACK_TIME_ZONES;
};

export const TIME_ZONE_OPTIONS = getSupportedTimeZones();
