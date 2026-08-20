import React, { useEffect, useRef, useState } from 'react';
import { Pressable, PressableStateCallbackType, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from './theme';

interface TooltipButtonProps {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle> | ((state: PressableStateCallbackType) => StyleProp<ViewStyle>);
  children: React.ReactNode;
  accessibilityLabel?: string;
  disabled?: boolean;
}

const TOOLTIP_AUTO_HIDE_MS = 1500;

export default function TooltipButton({ label, onPress, style, children, accessibilityLabel, disabled }: TooltipButtonProps) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
  }, []);

  const showTooltipBriefly = () => {
    setVisible(true);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    hideTimeoutRef.current = setTimeout(() => setVisible(false), TOOLTIP_AUTO_HIDE_MS);
  };

  return (
    <Pressable
      style={style}
      onPress={onPress}
      onLongPress={showTooltipBriefly}
      onHoverIn={() => setVisible(true)}
      onHoverOut={() => setVisible(false)}
      accessibilityLabel={accessibilityLabel || label}
      disabled={disabled}
    >
      {children}
      {visible ? (
        <View style={[localStyles.tooltip, { backgroundColor: colors.textPrimary }]} pointerEvents="none">
          <Text style={[localStyles.tooltipText, { color: colors.surface }]} numberOfLines={1}>{label}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const localStyles = StyleSheet.create({
  tooltip: {
    position: 'absolute',
    top: '100%',
    marginTop: 6,
    alignSelf: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    zIndex: 20,
    elevation: 6,
  },
  tooltipText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
