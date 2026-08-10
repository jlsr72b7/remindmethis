import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

interface TimePickerModalProps {
  visible: boolean;
  title: string;
  initialDate: Date;
  minuteInterval?: 1 | 5 | 15;
  saveLabel?: string;
  onSave: (value: Date) => void;
  onCancel: () => void;
}

export default function TimePickerModal({
  visible,
  title,
  initialDate,
  minuteInterval = 5,
  saveLabel = 'Save',
  onSave,
  onCancel,
}: TimePickerModalProps) {
  const [draftDate, setDraftDate] = useState<Date>(new Date(initialDate));

  useEffect(() => {
    if (!visible) {
      return;
    }

    setDraftDate(new Date(initialDate));
  }, [visible, initialDate]);

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.overlay} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>Pick a time</Text>

          <DateTimePicker
            value={draftDate}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            is24Hour={false}
            minuteInterval={minuteInterval}
            onChange={(_event, selectedDate) => {
              if (!selectedDate) {
                return;
              }
              setDraftDate(selectedDate);
            }}
          />

          <TouchableOpacity style={styles.saveButton} onPress={() => onSave(new Date(draftDate))} activeOpacity={0.85}>
            <Text style={styles.saveButtonText}>{saveLabel.toUpperCase()}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
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
    backgroundColor: '#9ca3af',
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 48,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    marginBottom: 10,
    color: '#111827',
    fontSize: 18,
  },
  saveButton: {
    marginTop: 18,
    borderRadius: 999,
    backgroundColor: '#0ea5e9',
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    width: '65%',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
});
