import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { ThemeColors, useTheme } from './theme';

interface TimePickerModalProps {
  visible: boolean;
  title: string;
  initialDate: Date;
  minuteInterval?: 1 | 5 | 15;
  saveLabel?: string;
  onSave: (value: Date) => void;
  onCancel: () => void;
}

const WHEEL_ITEM_HEIGHT = 42;
const WHEEL_VISIBLE_ROWS = 5;
const WHEEL_CENTER_PADDING = ((WHEEL_VISIBLE_ROWS - 1) / 2) * WHEEL_ITEM_HEIGHT;

export default function TimePickerModal({
  visible,
  title,
  initialDate,
  minuteInterval = 5,
  saveLabel = 'Save',
  onSave,
  onCancel,
}: TimePickerModalProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createTimePickerStyles(colors), [colors]);
  const [draftDate, setDraftDate] = useState<Date>(new Date(initialDate));
  const [webHour, setWebHour] = useState<number>(12);
  const [webMinute, setWebMinute] = useState<number>(0);
  const [webPeriod, setWebPeriod] = useState<'AM' | 'PM'>('AM');
  const [isWebReady, setIsWebReady] = useState(false);

  const hourOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const minuteOptions: number[] = [];
  for (let minute = 0; minute < 60; minute += minuteInterval) {
    minuteOptions.push(minute);
  }

  const [hourWheelRef, setHourWheelRef] = useState<FlatList<number> | null>(null);
  const [minuteWheelRef, setMinuteWheelRef] = useState<FlatList<number> | null>(null);

  const syncWebFieldsFromDate = (value: Date) => {
    const hours24 = value.getHours();
    const minute = value.getMinutes();
    const period = hours24 >= 12 ? 'PM' : 'AM';
    const hour12 = (hours24 % 12) || 12;
    const alignedMinute = minute - (minute % minuteInterval);

    setWebHour(hour12);
    setWebMinute(alignedMinute);
    setWebPeriod(period);
  };

  const buildDateFromWebFields = () => {
    const nextDate = new Date(draftDate);
    const normalizedHour = webHour % 12;
    const hours24 = webPeriod === 'PM' ? normalizedHour + 12 : normalizedHour;
    nextDate.setHours(hours24, webMinute, 0, 0);
    return nextDate;
  };

  const findNearestIndex = (offsetY: number, maxIndex: number) => {
    const raw = Math.round(offsetY / WHEEL_ITEM_HEIGHT);
    if (raw < 0) {
      return 0;
    }
    if (raw > maxIndex) {
      return maxIndex;
    }
    return raw;
  };

  const scrollWheelToIndex = (listRef: FlatList<number> | null, index: number) => {
    if (!listRef) {
      return;
    }

    listRef.scrollToOffset({
      offset: index * WHEEL_ITEM_HEIGHT,
      animated: false,
    });
  };

  const syncWebWheels = () => {
    const hourIndex = Math.max(0, hourOptions.findIndex((value) => value === webHour));
    const minuteIndex = Math.max(0, minuteOptions.findIndex((value) => value === webMinute));

    scrollWheelToIndex(hourWheelRef, hourIndex);
    scrollWheelToIndex(minuteWheelRef, minuteIndex);
  };

  useEffect(() => {
    if (!visible) {
      return;
    }

    const nextDate = new Date(initialDate);
    setDraftDate(nextDate);
    syncWebFieldsFromDate(nextDate);
    setIsWebReady(false);
  }, [visible, initialDate, minuteInterval]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) {
      return;
    }

    if (!hourWheelRef || !minuteWheelRef) {
      return;
    }

    if (!isWebReady) {
      syncWebWheels();
      setIsWebReady(true);
      return;
    }

    syncWebWheels();
  }, [visible, hourWheelRef, minuteWheelRef, isWebReady, webHour, webMinute]);

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.overlay} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>Pick a time</Text>

          <View style={styles.pickerWrap}>
            {Platform.OS === 'web' ? (
              <View style={styles.webPickerRow}>
                <View style={styles.webColumn}>
                  <Text style={styles.webLabel}>Hour</Text>
                  <View style={styles.webWheelFrame}>
                    <View style={styles.webWheelHighlight} pointerEvents="none" />
                    <FlatList
                      ref={(ref) => setHourWheelRef(ref)}
                      data={hourOptions}
                      keyExtractor={(item) => `hour-${item}`}
                      showsVerticalScrollIndicator={false}
                      snapToInterval={WHEEL_ITEM_HEIGHT}
                      decelerationRate="fast"
                      contentContainerStyle={styles.webWheelContent}
                      getItemLayout={(_data, index) => ({
                        length: WHEEL_ITEM_HEIGHT,
                        offset: WHEEL_ITEM_HEIGHT * index,
                        index,
                      })}
                      onMomentumScrollEnd={(event) => {
                        const index = findNearestIndex(event.nativeEvent.contentOffset.y, hourOptions.length - 1);
                        const nextHour = hourOptions[index];
                        if (nextHour !== webHour) {
                          setWebHour(nextHour);
                        }
                        scrollWheelToIndex(hourWheelRef, index);
                      }}
                      renderItem={({ item }) => {
                        const selected = item === webHour;
                        return (
                          <Pressable
                            style={styles.webWheelItem}
                            onPress={() => {
                              setWebHour(item);
                              const selectedIndex = hourOptions.findIndex((value) => value === item);
                              scrollWheelToIndex(hourWheelRef, selectedIndex);
                            }}
                          >
                            <Text style={[styles.webWheelText, selected ? styles.webWheelTextActive : undefined]}>
                              {String(item).padStart(2, '0')}
                            </Text>
                          </Pressable>
                        );
                      }}
                    />
                  </View>
                </View>

                <View style={styles.webColumn}>
                  <Text style={styles.webLabel}>Minute</Text>
                  <View style={styles.webWheelFrame}>
                    <View style={styles.webWheelHighlight} pointerEvents="none" />
                    <FlatList
                      ref={(ref) => setMinuteWheelRef(ref)}
                      data={minuteOptions}
                      keyExtractor={(item) => `minute-${item}`}
                      showsVerticalScrollIndicator={false}
                      snapToInterval={WHEEL_ITEM_HEIGHT}
                      decelerationRate="fast"
                      contentContainerStyle={styles.webWheelContent}
                      getItemLayout={(_data, index) => ({
                        length: WHEEL_ITEM_HEIGHT,
                        offset: WHEEL_ITEM_HEIGHT * index,
                        index,
                      })}
                      onMomentumScrollEnd={(event) => {
                        const index = findNearestIndex(event.nativeEvent.contentOffset.y, minuteOptions.length - 1);
                        const nextMinute = minuteOptions[index];
                        if (nextMinute !== webMinute) {
                          setWebMinute(nextMinute);
                        }
                        scrollWheelToIndex(minuteWheelRef, index);
                      }}
                      renderItem={({ item }) => {
                        const selected = item === webMinute;
                        return (
                          <Pressable
                            style={styles.webWheelItem}
                            onPress={() => {
                              setWebMinute(item);
                              const selectedIndex = minuteOptions.findIndex((value) => value === item);
                              scrollWheelToIndex(minuteWheelRef, selectedIndex);
                            }}
                          >
                            <Text style={[styles.webWheelText, selected ? styles.webWheelTextActive : undefined]}>
                              {String(item).padStart(2, '0')}
                            </Text>
                          </Pressable>
                        );
                      }}
                    />
                  </View>
                </View>

                <View style={styles.webColumn}>
                  <Text style={styles.webLabel}>Period</Text>
                  <Pressable
                    style={[styles.periodButton, webPeriod === 'AM' ? styles.periodButtonActive : undefined]}
                    onPress={() => setWebPeriod('AM')}
                  >
                    <Text style={[styles.periodButtonText, webPeriod === 'AM' ? styles.periodButtonTextActive : undefined]}>AM</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.periodButton, webPeriod === 'PM' ? styles.periodButtonActive : undefined]}
                    onPress={() => setWebPeriod('PM')}
                  >
                    <Text style={[styles.periodButtonText, webPeriod === 'PM' ? styles.periodButtonTextActive : undefined]}>PM</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <DateTimePicker
                value={draftDate}
                mode="time"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                is24Hour={false}
                minuteInterval={minuteInterval}
                style={styles.picker}
                onChange={(_event, selectedDate) => {
                  if (!selectedDate) {
                    return;
                  }
                  setDraftDate(selectedDate);
                }}
              />
            )}
          </View>

          <TouchableOpacity
            style={styles.saveButton}
            onPress={() => onSave(Platform.OS === 'web' ? buildDateFromWebFields() : new Date(draftDate))}
            activeOpacity={0.85}
          >
            <Text style={styles.saveButtonText}>{saveLabel.toUpperCase()}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createTimePickerStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 28,
    minHeight: 360,
  },
  handle: {
    width: 56,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.textPlaceholder,
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 10,
    color: colors.textPrimary,
    fontSize: 18,
  },
  pickerWrap: {
    minHeight: 220,
    justifyContent: 'center',
  },
  picker: {
    width: '100%',
    height: 216,
    alignSelf: 'stretch',
  },
  webPickerRow: {
    flexDirection: 'row',
    gap: 12,
  },
  webColumn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 10,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  webLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textSecondary,
    marginBottom: 6,
  },
  webWheelFrame: {
    width: '100%',
    height: WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ROWS,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 10,
    backgroundColor: colors.surfaceSubtle,
  },
  webWheelHighlight: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: WHEEL_CENTER_PADDING,
    height: WHEEL_ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.primarySoft,
    backgroundColor: colors.borderTint,
    opacity: 0.65,
    zIndex: 1,
  },
  webWheelContent: {
    paddingVertical: WHEEL_CENTER_PADDING,
  },
  webWheelItem: {
    height: WHEEL_ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  webWheelText: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textTertiary,
  },
  webWheelTextActive: {
    color: colors.primaryPressed,
  },
  periodButton: {
    width: '100%',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderTint,
    alignItems: 'center',
    marginBottom: 8,
  },
  periodButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  periodButtonText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  periodButtonTextActive: {
    color: colors.surface,
  },
  saveButton: {
    marginTop: 18,
    borderRadius: 999,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    width: '65%',
  },
  saveButtonText: {
    color: colors.surface,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
});
