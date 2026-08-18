import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts/legacy';
import {
  Alert,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Picker } from '@react-native-picker/picker';
import * as Calendar from 'expo-calendar/legacy';
import AppContent from './src/AppContent';
import TimePickerModal from './src/TimePickerModal';
import {
  CalendarSyncPermission,
  CalendarSyncProvider,
  changePassword,
  createUser,
  disconnectGoogleCalendarConnection,
  disconnectOutlookCalendarConnection,
  deleteUser,
  findUserByEmail,
  getGoogleAuthorizationConnectUrl,
  getGoogleConnectionStatus,
  getOutlookAuthorizationConnectUrl,
  getOutlookConnectionStatus,
  isApiStorageEnabled,
  isApiReachable,
  loadCalendarSyncSettings,
  loadReminderDefaultTimeSettings,
  loadReminderDeliverySettings,
  loadReminderSoundSettings,
  loadReminderTimeZoneSettings,
  loadUser,
  loadEvents,
  findGoogleAddressPredictions,
  resolveGoogleAddressPrediction,
  migrateLocalUsersAndEventsToApi,
  pushGoogleCalendarEvents,
  saveCalendarSyncSettings,
  saveReminderDefaultTimeSettings,
  saveReminderDeliverySettings,
  saveReminderSoundSettings,
  saveReminderTimeZoneSettings,
  sendContactSupportMessage,
  resetPassword,
  resendVerificationEmail,
  loadUserContactsSnapshot,
  saveUserContactsSnapshot,
  signInUser,
  startMobileVerification,
  StoredUser,
  updateUserProfile,
  validateBirthDate,
  validateEmail,
  validatePassword,
  validatePhoneNumber,
  verifyMobileVerificationCode,
  type GoogleAddressPrediction,
} from './src/storage';
import { getDeviceTimeZone, TIME_ZONE_OPTIONS } from './src/timeZones';

type AuthMode = 'signin' | 'signup' | 'forgot';

const API_PUBLIC_BASE_URL = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_BASE_URL
  ? process.env.EXPO_PUBLIC_API_BASE_URL
  : 'http://localhost:4000').replace(/\/$/, '');
const USER_AGREEMENT_URL = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_USER_AGREEMENT_URL
  ? process.env.EXPO_PUBLIC_USER_AGREEMENT_URL
  : `${API_PUBLIC_BASE_URL}/legal/user-agreement`).trim();

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: null,
    };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Unknown render error',
    };
  }

  componentDidCatch(error: Error) {
    console.error('Top-level app render error', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={styles.container}>
          <View style={styles.migrationSplash}>
            <Text style={styles.migrationSplashTitle}>App encountered a startup error</Text>
            <Text style={styles.migrationSplashText}>
              {this.state.errorMessage || 'A rendering problem occurred during startup.'}
            </Text>
            <Text style={styles.migrationSplashText}>
              Reload the app. If this persists, backend can stay off and local mode should still work.
            </Text>
          </View>
          <StatusBar style="auto" />
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

const formatBirthDateInput = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 8);

  if (!digits) {
    return '';
  }

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }

  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};

const normalizeUsPhoneDigits = (value: string) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  return digits.slice(0, 10);
};

const formatPhoneNumberInput = (value: string) => {
  const digits = normalizeUsPhoneDigits(value);

  if (!digits) {
    return '';
  }

  if (digits.length <= 3) {
    return `(${digits}`;
  }

  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

const generateUUID = () => {
  const timestamp = Date.now().toString(36);
  const random1 = Math.random().toString(36).slice(2, 10);
  const random2 = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random1}-${random2}`;
};

const formatReminderTimeLabel = (hour: number, minute: number) => {
  const normalizedHour = Math.max(0, Math.min(23, Math.trunc(hour)));
  const normalizedMinute = Math.max(0, Math.min(59, Math.trunc(minute)));
  const period = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour}:${String(normalizedMinute).padStart(2, '0')} ${period}`;
};

const normalizeClockIntervalMinutes = (value: number): 1 | 5 | 15 => {
  if (value === 1 || value === 5 || value === 15) {
    return value;
  }

  return 5;
};

const alignMinuteToClockInterval = (minute: number, interval: 1 | 5 | 15): number => {
  const normalizedMinute = Math.max(0, Math.min(59, Math.trunc(minute)));
  return normalizedMinute - (normalizedMinute % interval);
};

const splitNameParts = (fullName: string) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { firstName: '', lastName: '' };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
};

const normalizePhoneDigits = (value: string) => String(value || '').replace(/\D/g, '').slice(0, 10);

const getContactDisplayName = (contact: { firstName?: string; lastName?: string; company?: string }) => {
  const fullName = `${String(contact.firstName || '').trim()} ${String(contact.lastName || '').trim()}`.trim();
  if (fullName) {
    return fullName;
  }

  return String(contact.company || '').trim() || 'Unnamed contact';
};

const getContactPrimaryChannelLabel = (contact: { email?: string; mobileNumber?: string }) => {
  const normalizedEmail = String(contact.email || '').trim();
  if (normalizedEmail) {
    return normalizedEmail;
  }

  const normalizedMobile = String(contact.mobileNumber || '').trim();
  if (normalizedMobile) {
    return normalizedMobile;
  }

  return 'No email or mobile phone';
};

const formatImportedBirthDate = (birthday?: { month?: number | null; day?: number | null; year?: number | null } | null) => {
  const month = Number(birthday?.month || 0);
  const day = Number(birthday?.day || 0);
  const year = Number(birthday?.year || 0);

  if (!month || !day || !year) {
    return '';
  }

  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${String(year).padStart(4, '0')}`;
};

const parseAddressParts = (address: string) => {
  const lines = String(address || '').split('\n').map((line) => line.trim());

  const line1 = lines[0] || '';
  let line2 = lines[1] || '';
  const line3 = lines[2] || '';
  const line4 = lines[3] || '';

  const parseCombinedCityStateZip = (value: string) => {
    const normalized = String(value || '').trim();
    const cityStateZipMatch = normalized.match(/^(.*?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (cityStateZipMatch) {
      return {
        city: cityStateZipMatch[1].trim(),
        state: cityStateZipMatch[2].toUpperCase(),
        zip: cityStateZipMatch[3],
      };
    }

    return null;
  };

  let city = '';
  let state = '';
  let zip = '';

  if (line4) {
    city = line3.trim();
    const stateZipMatch = line4.match(/^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
    if (stateZipMatch) {
      state = stateZipMatch[1].toUpperCase();
      zip = stateZipMatch[2] || '';
    } else {
      const fallback = parseCombinedCityStateZip(line4);
      if (fallback) {
        city = city || fallback.city;
        state = fallback.state;
        zip = fallback.zip;
      }
    }
  } else if (line3) {
    const parsedLegacyLine3 = parseCombinedCityStateZip(line3);
    if (parsedLegacyLine3) {
      city = parsedLegacyLine3.city;
      state = parsedLegacyLine3.state;
      zip = parsedLegacyLine3.zip;
    } else {
      city = line3.trim();
    }
  } else if (line2) {
    // Backward compatibility: older values may store two lines as [line1, city/state/zip].
    const parsedLegacyLine2 = parseCombinedCityStateZip(line2);
    if (parsedLegacyLine2) {
      city = parsedLegacyLine2.city;
      state = parsedLegacyLine2.state;
      zip = parsedLegacyLine2.zip;
      line2 = '';
    }
  }

  return {
    line1,
    line2,
    city,
    state,
    zip,
  };
};

const composeAddressParts = (parts: { line1: string; line2: string; city: string; state: string; zip: string }) => {
  const line1 = parts.line1.trim();
  const line2 = parts.line2.trim();
  const city = parts.city.trim();
  const state = parts.state.trim().toUpperCase();
  const zip = parts.zip.trim();
  const line4 = [state, zip].filter(Boolean).join(' ').trim();

  if (!line1 && !line2 && !city && !line4) {
    return '';
  }

  if (!city && !line4) {
    return [line1, line2].filter(Boolean).join('\n');
  }

  if (!line4) {
    return `${line1}\n${line2}\n${city}`;
  }

  // Keep line2 and city positions even when blank so state/zip remains on line 4.
  return `${line1}\n${line2}\n${city}\n${line4}`;
};

interface AuthScreenProps {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onAuthenticated: (email: string, userId: string) => void;
  bootstrapNote?: string | null;
}

function AuthScreen({ mode, onModeChange, onAuthenticated, bootstrapNote }: AuthScreenProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [signupSmsConsent, setSignupSmsConsent] = useState<'Y' | 'N' | ''>('');
  const [streetAddress, setStreetAddress] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [signupAddressPredictions, setSignupAddressPredictions] = useState<GoogleAddressPrediction[]>([]);
  const [isSignupAddressFocused, setIsSignupAddressFocused] = useState(false);
  const [signupAddressAutocompleteSessionToken] = useState(() => `addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const skipNextSignupAutocompleteFetchRef = useRef(0);
  const isSelectingSignupAddressPredictionRef = useRef(false);
  const signupAddressBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [hasAcceptedUserAgreement, setHasAcceptedUserAgreement] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showResendVerificationLink, setShowResendVerificationLink] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const successAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const cardTranslateY = useRef(new Animated.Value(0)).current;
  const cardTranslateX = useRef(new Animated.Value(0)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;

  const title = mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password';
  const subtitle = mode === 'signin'
    ? 'Welcome back'
    : mode === 'signup'
      ? 'Enter email and use as login ID *'
      : 'Enter your email to reset your password';

  const passwordRules = [
    { label: 'At least 8 characters', isMet: password.length >= 8 },
    { label: 'At least 1 capital letter', isMet: /[A-Z]/.test(password) },
    { label: 'At least 1 number', isMet: /\d/.test(password) },
    { label: 'At least 1 special character', isMet: /[^A-Za-z0-9]/.test(password) },
  ];

  const formatPhoneNumber = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);

    if (!digits) {
      return '';
    }

    if (digits.length <= 3) {
      return `(${digits}`;
    }

    if (digits.length <= 6) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    }

    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  };

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1,
      useNativeDriver: true,
    }).start();

    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ]),
      { iterations: -1 },
    );
    glowLoop.start();

    Animated.timing(cardTranslateX, { toValue: 0, duration: 1, useNativeDriver: true }).start();

    return () => {
      glowLoop.stop();
      fadeAnim.setValue(1);
      glowAnim.setValue(0);
      cardTranslateY.setValue(0);
      cardTranslateX.setValue(0);
    };
  }, [fadeAnim, glowAnim]);

  useEffect(() => {
    if (!successMessage) {
      successAnim.setValue(0);
      return;
    }

    Animated.sequence([
      Animated.timing(successAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.timing(successAnim, { toValue: 0, duration: 220, delay: 900, useNativeDriver: true }),
    ]).start();
  }, [successMessage, successAnim]);

  useEffect(() => {
    if (mode !== 'signup') {
      setHasAcceptedUserAgreement(false);
      setSignupSmsConsent('');
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'signin') {
      setShowResendVerificationLink(false);
      setIsResendingVerification(false);
    }
  }, [mode]);

  useEffect(() => () => {
    if (signupAddressBlurTimeoutRef.current) {
      clearTimeout(signupAddressBlurTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    let isActive = true;
    const query = streetAddress.trim();

    if (mode !== 'signup' || !isSignupAddressFocused) {
      setSignupAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (query.length < 4) {
      setSignupAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (skipNextSignupAutocompleteFetchRef.current > 0) {
      skipNextSignupAutocompleteFetchRef.current -= 1;
      setSignupAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    const timeoutId = setTimeout(() => {
      void findGoogleAddressPredictions(query, signupAddressAutocompleteSessionToken).then((predictions) => {
        if (isActive) {
          setSignupAddressPredictions(predictions);
        }
      });
    }, 250);

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [isSignupAddressFocused, mode, signupAddressAutocompleteSessionToken, streetAddress]);

  const applySignupAddressPrediction = useCallback(async (prediction: GoogleAddressPrediction) => {
    skipNextSignupAutocompleteFetchRef.current = 2;
    isSelectingSignupAddressPredictionRef.current = false;
    setSignupAddressPredictions([]);
    setIsSignupAddressFocused(false);
    setStreetAddress(prediction.mainText || prediction.description || '');

    const resolved = await resolveGoogleAddressPrediction(prediction.placeId, signupAddressAutocompleteSessionToken);
    const nextLine1 = resolved?.line1 || prediction.mainText || prediction.description;

    setStreetAddress(nextLine1);
    if (resolved) {
      setCity(resolved.city || '');
      setState(resolved.state || '');
      setZipCode(resolved.zip || '');
    }

    if (message) {
      setMessage(null);
    }
  }, [message, signupAddressAutocompleteSessionToken]);

  const handleSubmit = async () => {
    if (!email.trim()) {
      setMessage('Please enter your email address.');
      return;
    }

    if (!validateEmail(email)) {
      setMessage('Please enter a valid email address.');
      return;
    }

    if (mode === 'forgot') {
      setIsSubmitting(true);
      const result = await resetPassword(email.trim().toLowerCase());
      setIsSubmitting(false);

      if (!result) {
        setMessage('No account was found for that email.');
        return;
      }

      setMessage(`Password reset for ${email.trim().toLowerCase()}. Please sign in with your new temporary password.`);
      setPassword('');
      setConfirmPassword('');
      onModeChange('signin');
      return;
    }

    if (!password) {
      setMessage('Please enter your password.');
      return;
    }

    if (mode === 'signup') {
      if (!firstName.trim()) {
        setMessage('Please enter your first name.');
        return;
      }

      if (!lastName.trim()) {
        setMessage('Please enter your last name.');
        return;
      }

      if (!mobileNumber.trim()) {
        setMessage('Please enter your mobile phone number.');
        return;
      }

      const phoneError = validatePhoneNumber(mobileNumber);
      if (phoneError) {
        setMessage(phoneError);
        return;
      }

      if (birthDate.trim()) {
        const birthDateError = validateBirthDate(birthDate);
        if (birthDateError) {
          setMessage(birthDateError);
          return;
        }
      }

      if (password !== confirmPassword) {
        setMessage('Passwords do not match. Please confirm your password.');
        return;
      }

      if (signupSmsConsent !== 'Y' && signupSmsConsent !== 'N') {
        setMessage('Please choose Y or N for SMS reminders consent.');
        return;
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        setMessage(passwordError);
        return;
      }

      if (!hasAcceptedUserAgreement) {
        setMessage('Please confirm that you have read and agree to the user agreement.');
        return;
      }

      const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
      const address = '';

      setIsSubmitting(true);
      const result = await createUser(
        email.trim().toLowerCase(),
        password,
        mobileNumber.trim(),
        fullName,
        address,
        birthDate.trim(),
        signupSmsConsent === 'Y',
      );
      setIsSubmitting(false);

      if (result.error) {
        setMessage(result.error);
        setShowResendVerificationLink(false);
        return;
      }

      setFirstName('');
      setLastName('');
      setBirthDate('');
      setStreetAddress('');
      setAddressLine2('');
      setCity('');
      setState('');
      setZipCode('');
      setPassword('');
      setConfirmPassword('');
      setMobileNumber('');
      setSignupSmsConsent('');
      setHasAcceptedUserAgreement(false);
      setSuccessMessage(
        result.message
          ? result.message
          : `Account created for ${result.user!.email}. Please verify your email before signing in.`,
      );
      onModeChange('signin');
      return;
    }

    setIsSubmitting(true);
    const signInResult = await signInUser(email.trim().toLowerCase(), password);
    setIsSubmitting(false);

    if (!signInResult.user) {
      if (signInResult.error && /email not verified/i.test(signInResult.error)) {
        setMessage('Please verify your email address before signing in. Check your inbox for the verification link.');
        setShowResendVerificationLink(true);
        return;
      }

      setMessage('We could not find an account with those details.');
      setShowResendVerificationLink(false);
      return;
    }

    setShowResendVerificationLink(false);
    onAuthenticated(signInResult.user.email, signInResult.user.id);
  };

  const handleResendVerification = async () => {
    if (!email.trim()) {
      setMessage('Enter your email address first, then resend verification.');
      return;
    }

    if (!validateEmail(email)) {
      setMessage('Please enter a valid email address before resending verification.');
      return;
    }

    setIsResendingVerification(true);
    const result = await resendVerificationEmail(email.trim().toLowerCase());
    setIsResendingVerification(false);

    if (!result.success) {
      setMessage(result.error || 'Unable to resend verification email right now.');
      return;
    }

    setMessage(result.message || 'Verification email resent. Check your inbox.');
  };

  const handleOpenUserAgreement = async () => {
    if (!USER_AGREEMENT_URL) {
      setMessage('User agreement link is not configured yet. Set EXPO_PUBLIC_USER_AGREEMENT_URL.');
      Alert.alert('User agreement unavailable', 'Set EXPO_PUBLIC_USER_AGREEMENT_URL in the frontend .env and restart Expo.');
      return;
    }

    try {
      const canOpen = await Linking.canOpenURL(USER_AGREEMENT_URL);
      if (!canOpen) {
        setMessage('Unable to open the user agreement on this device.');
        Alert.alert('Unable to open link', 'This device could not open the user agreement link.');
        return;
      }

      await Linking.openURL(USER_AGREEMENT_URL);
    } catch {
      setMessage('Unable to open the user agreement right now.');
      Alert.alert('Unable to open link', 'The user agreement could not be opened right now.');
    }
  };

  return (
    <Animated.View style={[styles.authContainer, { opacity: fadeAnim }] }>
      <Animated.View
        style={[
          styles.glowOrb,
          {
            opacity: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.32] }),
            transform: [{ scale: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.08] }) }],
          },
        ]}
      />
      <ScrollView
        style={styles.authScroll}
        contentContainerStyle={styles.authScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          style={[
            styles.authCard,
            {
              transform: [
                { translateY: cardTranslateY },
                { translateX: cardTranslateX },
              ],
            },
          ]}
        >
          <View style={styles.heroRow}>
            <Image source={require('./assets/icon.png')} style={styles.brandBadgeImage} resizeMode="cover" />
            <View style={styles.heroTextWrap}>
              <Text style={styles.appName}>Remind Me This</Text>
              <Text style={styles.appTagline}>Stay on top of every important moment</Text>
            </View>
          </View>

          {mode === 'forgot' ? (
            <View style={[styles.modePill, styles.modePillDefault]}>
              <Text style={[styles.modePillText, styles.modePillTextActive]}>
                Reset password
              </Text>
            </View>
          ) : null}

          <Text style={styles.title}>{title}</Text>
          {mode === 'signup' ? <Text style={styles.userAgreementCaption}>* mandatory fields</Text> : null}
          <Text style={styles.subtitle}>{subtitle}</Text>

          {bootstrapNote ? <Text style={styles.bootstrapNote}>{bootstrapNote}</Text> : null}

          {message ? <Text style={styles.message}>{message}</Text> : null}
          {mode === 'signin' && showResendVerificationLink ? (
            <TouchableOpacity
              style={styles.resendVerificationLinkWrap}
              onPress={() => void handleResendVerification()}
              disabled={isResendingVerification || isSubmitting}
              activeOpacity={0.8}
            >
              <Text style={[styles.resendVerificationLinkText, (isResendingVerification || isSubmitting) && styles.resendVerificationLinkTextDisabled]}>
                {isResendingVerification ? 'Resending verification email...' : 'Resend verification email'}
              </Text>
            </TouchableOpacity>
          ) : null}

          {successMessage ? (
            <Animated.View style={[styles.successToast, { opacity: successAnim }] }>
              <Text style={styles.successToastText}>{successMessage}</Text>
            </Animated.View>
          ) : null}

          <TextInput
            style={styles.input}
            placeholder="Email address"
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              if (message) {
                setMessage(null);
              }
              if (showResendVerificationLink) {
                setShowResendVerificationLink(false);
              }
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType={mode === 'forgot' ? 'done' : 'next'}
            onSubmitEditing={() => {
              if (mode === 'forgot' && !isSubmitting) {
                handleSubmit();
              }
            }}
          />

          {mode === 'signup' ? (
            <>
              <Text style={styles.signupPersonalDetailsTitle}>Personal details</Text>

              <View style={styles.accountNameRow}>
                <View style={styles.accountInlineField}>
                  <Text style={styles.fieldLabel}>First name *</Text>
                  <TextInput
                    style={[styles.input, styles.accountCompactInput]}
                    placeholder="First name"
                    value={firstName}
                    onChangeText={(value) => {
                      setFirstName(value);
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    autoCapitalize="words"
                  />
                </View>
                <View style={styles.accountInlineField}>
                  <Text style={styles.fieldLabel}>Last name *</Text>
                  <TextInput
                    style={[styles.input, styles.accountCompactInput]}
                    placeholder="Last name"
                    value={lastName}
                    onChangeText={(value) => {
                      setLastName(value);
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    autoCapitalize="words"
                  />
                </View>
              </View>

              <View style={styles.accountMobileBirthRow}>
                <View style={styles.accountInlineField}>
                  <Text style={styles.fieldLabel}>Mobile phone *</Text>
                  <TextInput
                    style={[styles.input, styles.accountCompactInput]}
                    placeholder="(555) 555-5555"
                    value={mobileNumber}
                    onChangeText={(value) => {
                      setMobileNumber(formatPhoneNumber(value));
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    keyboardType="phone-pad"
                    maxLength={14}
                  />
                </View>
                <View style={styles.accountInlineField}>
                  <Text style={styles.fieldLabel}>Birth date</Text>
                  <TextInput
                    style={[styles.input, styles.accountCompactInput]}
                    placeholder="mm/dd/yyyy"
                    value={birthDate}
                    onChangeText={(value) => {
                      setBirthDate(formatBirthDateInput(value));
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    keyboardType="number-pad"
                    maxLength={10}
                  />
                </View>
              </View>

              <View style={styles.signupSmsConsentBlock}>
                <Text style={styles.fieldLabel}>SMS reminders consent *</Text>
                <Text style={styles.authAgreementText}>
                  Remind Me This: Would you like to receive reminder text messages for your account?
                </Text>
                <Text style={styles.signupSmsConsentHint}>
                  Reply choice in app: Y for Yes or N for No. Msg frequency varies. Msg and data rates may apply. Reply STOP to cancel, HELP for help.
                </Text>
                <View style={styles.signupSmsConsentActions}>
                  <TouchableOpacity
                    style={[
                      styles.signupSmsConsentButton,
                      signupSmsConsent === 'Y' ? styles.signupSmsConsentButtonSelected : null,
                    ]}
                    onPress={() => {
                      setSignupSmsConsent('Y');
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[
                      styles.signupSmsConsentButtonText,
                      signupSmsConsent === 'Y' ? styles.signupSmsConsentButtonTextSelected : null,
                    ]}>Y</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.signupSmsConsentButton,
                      signupSmsConsent === 'N' ? styles.signupSmsConsentButtonSelected : null,
                    ]}
                    onPress={() => {
                      setSignupSmsConsent('N');
                      if (message) {
                        setMessage(null);
                      }
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[
                      styles.signupSmsConsentButtonText,
                      signupSmsConsent === 'N' ? styles.signupSmsConsentButtonTextSelected : null,
                    ]}>N</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : null}

          {mode !== 'forgot' ? (
            <View style={styles.passwordInputWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password"
                value={password}
                onChangeText={(value) => {
                  setPassword(value);
                  if (message) {
                    setMessage(null);
                  }
                }}
                secureTextEntry={!showPassword}
                returnKeyType={mode === 'signup' ? 'next' : 'done'}
                onSubmitEditing={() => {
                  if (mode === 'signin' && !isSubmitting) {
                    handleSubmit();
                  }
                }}
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowPassword((value) => !value)} activeOpacity={0.8}>
                <Text style={styles.passwordToggleText}>{showPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {mode === 'signup' ? (
            <View style={styles.passwordInputWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Confirm password"
                value={confirmPassword}
                onChangeText={(value) => {
                  setConfirmPassword(value);
                  if (message) {
                    setMessage(null);
                  }
                }}
                secureTextEntry={!showConfirmPassword}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (!isSubmitting) {
                    handleSubmit();
                  }
                }}
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowConfirmPassword((value) => !value)} activeOpacity={0.8}>
                <Text style={styles.passwordToggleText}>{showConfirmPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {mode === 'signup' ? (
            <View style={styles.rulesBox}>
              {passwordRules.map((rule) => (
                <Text key={rule.label} style={[styles.ruleText, rule.isMet ? styles.ruleTextMet : styles.ruleTextUnmet]}>{rule.label}</Text>
              ))}
            </View>
          ) : null}

          {mode === 'signup' ? (
            <View style={styles.authAgreementBlock}>
              <TouchableOpacity
                style={styles.authAgreementRow}
                onPress={() => {
                  setHasAcceptedUserAgreement((current) => !current);
                  if (message) {
                    setMessage(null);
                  }
                }}
                activeOpacity={0.8}
              >
                <View style={styles.passwordCheckbox}>
                  {hasAcceptedUserAgreement ? <View style={styles.passwordCheckboxChecked} /> : null}
                </View>
                <Text style={styles.authAgreementText}>I have read and agree to this user agreement.</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void handleOpenUserAgreement()}
                activeOpacity={0.8}
                disabled={!USER_AGREEMENT_URL}
              >
                <Text style={[styles.authAgreementLink, !USER_AGREEMENT_URL && styles.authAgreementLinkDisabled]}>View user agreement</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
            <TouchableOpacity
              style={styles.submitButton}
              onPress={handleSubmit}
              disabled={isSubmitting}
              onPressIn={() => Animated.spring(buttonScale, { toValue: 0.97, useNativeDriver: true }).start()}
              onPressOut={() => Animated.spring(buttonScale, { toValue: 1, friction: 6, useNativeDriver: true }).start()}
            >
              <Text style={styles.submitButtonText}>{isSubmitting ? 'Please wait…' : title}</Text>
            </TouchableOpacity>
          </Animated.View>

          <View style={styles.linkRow}>
            <TouchableOpacity onPress={() => {
              setMessage(null);
              onModeChange(mode === 'signin' ? 'signup' : mode === 'signup' ? 'signin' : 'signin');
            }}>
              <Text style={styles.switchText}>
                {mode === 'signin' ? "Don't have an account? Create one" : mode === 'signup' ? 'Already have an account? Sign in' : 'Back to sign in'}
              </Text>
            </TouchableOpacity>

            {mode === 'signin' ? (
              <TouchableOpacity onPress={() => {
                setMessage(null);
                onModeChange('forgot');
              }}>
                <Text style={styles.secondaryLink}>Forgot password?</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}

interface AccountScreenProps {
  user: StoredUser;
  onBack: () => void;
  onUserUpdated: (user: StoredUser) => void;
  onDeleteAccount: () => void;
  onReminderTimeZoneUpdated: (timeZone: string) => void;
  initialAccountAction?: 'contacts' | 'calendar-sync' | null;
  returnToLanding?: boolean;
  onInitialActionHandled?: () => void;
  onBackToLanding?: () => void;
}

interface AccountContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  birthDate: string;
  mobileNumber?: string;
  company: string;
  notes: string;
  isFavorite: boolean;
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ContactGroup {
  id: string;
  name: string;
  description: string;
  contactIds: string[];
  createdAt: string;
}

interface ContactsSnapshot {
  contacts: AccountContact[];
  groups: ContactGroup[];
  ownerUserId?: string;
  ownerEmail?: string;
  schemaVersion?: number;
  updatedAt?: string;
}

interface DeviceContactImportCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mobileNumber: string;
  company: string;
  birthDate: string;
}

type ContactsView = 'none' | 'contacts' | 'favorites' | 'groups';
type ContactsDisplayMode = 'detail' | 'summary';
type GroupsDisplayMode = 'new' | 'summary' | 'manage';
type AccountAction = 'none' | 'profile' | 'settings' | 'calendar-sync';

const createEmptyContactDraft = () => ({
  email: '',
  firstName: '',
  lastName: '',
  address: '',
  birthDate: '',
  mobileNumber: '',
  company: '',
  notes: '',
});

const CONTACTS_STORAGE_KEY_PREFIX = 'special-date-contacts:';
const getContactsStorageKey = (userId: string) => `${CONTACTS_STORAGE_KEY_PREFIX}${userId}`;

function AccountScreen({
  user,
  onBack,
  onUserUpdated,
  onDeleteAccount,
  onReminderTimeZoneUpdated,
  initialAccountAction,
  returnToLanding,
  onInitialActionHandled,
  onBackToLanding,
}: AccountScreenProps) {
  const initialNameParts = useMemo(() => splitNameParts(user.fullName || ''), [user.fullName]);
  const initialAddressParts = useMemo(() => parseAddressParts(user.address || ''), [user.address]);
  const [firstName, setFirstName] = useState(initialNameParts.firstName);
  const [lastName, setLastName] = useState(initialNameParts.lastName);
  const [addressLine1, setAddressLine1] = useState(initialAddressParts.line1);
  const [addressLine2, setAddressLine2] = useState(initialAddressParts.line2);
  const [addressCity, setAddressCity] = useState(initialAddressParts.city);
  const [addressState, setAddressState] = useState(initialAddressParts.state);
  const [addressZip, setAddressZip] = useState(initialAddressParts.zip);
  const [addressPredictions, setAddressPredictions] = useState<GoogleAddressPrediction[]>([]);
  const [isAccountAddressLine1Focused, setIsAccountAddressLine1Focused] = useState(false);
  const [addressAutocompleteSessionToken] = useState(() => `addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const skipNextAccountAutocompleteFetchRef = useRef(0);
  const [birthDate, setBirthDate] = useState(user.birthDate || '');
  const [mobileNumber, setMobileNumber] = useState(formatPhoneNumberInput(user.mobileNumber || ''));
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [reminderSoundOff, setReminderSoundOff] = useState(false);
  const [showDefaultReminderTimeEditor, setShowDefaultReminderTimeEditor] = useState(false);
  const [showReminderTimeZoneEditor, setShowReminderTimeZoneEditor] = useState(false);
  const [showDeviceNotificationInstructions, setShowDeviceNotificationInstructions] = useState(false);
  const [defaultReminderHour, setDefaultReminderHour] = useState(9);
  const [defaultReminderMinute, setDefaultReminderMinute] = useState(0);
  const [defaultReminderDraftHour, setDefaultReminderDraftHour] = useState(9);
  const [defaultReminderDraftMinute, setDefaultReminderDraftMinute] = useState(0);
  const [defaultReminderClockInterval, setDefaultReminderClockInterval] = useState<1 | 5 | 15>(5);
  const [defaultReminderDraftClockInterval, setDefaultReminderDraftClockInterval] = useState<1 | 5 | 15>(5);
  const [isSavingDefaultReminderTime, setIsSavingDefaultReminderTime] = useState(false);
  const [defaultReminderTimeZone, setDefaultReminderTimeZone] = useState(getDeviceTimeZone());
  const [defaultReminderTimeZoneDraft, setDefaultReminderTimeZoneDraft] = useState(getDeviceTimeZone());
  const [isSavingReminderTimeZone, setIsSavingReminderTimeZone] = useState(false);
  const [calendarSyncProviderDraft, setCalendarSyncProviderDraft] = useState<CalendarSyncProvider>('none');
  const [googleCalendarPermission, setGoogleCalendarPermission] = useState<CalendarSyncPermission>('write');
  const [googleCalendarId, setGoogleCalendarId] = useState('');
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);
  const [isGoogleSyncPaused, setIsGoogleSyncPaused] = useState(false);
  const [isGoogleAutoSyncEnabled, setIsGoogleAutoSyncEnabled] = useState(true);
  const [googleCalendarIdDraft, setGoogleCalendarIdDraft] = useState('');
  const [outlookCalendarEmail, setOutlookCalendarEmail] = useState('');
  const [outlookCalendarEmailDraft, setOutlookCalendarEmailDraft] = useState('');
  const [isOutlookConnected, setIsOutlookConnected] = useState(false);
  const [isOutlookSyncPaused, setIsOutlookSyncPaused] = useState(false);
  const [appleCalendarId, setAppleCalendarId] = useState('');
  const [appleCalendarName, setAppleCalendarName] = useState('');
  const [appleCalendarIdDraft, setAppleCalendarIdDraft] = useState('');
  const [appleCalendarNameDraft, setAppleCalendarNameDraft] = useState('');
  const [appleAvailableCalendars, setAppleAvailableCalendars] = useState<Array<{ id: string; title: string }>>([]);
  const [isAppleConnected, setIsAppleConnected] = useState(false);
  const [isAppleSyncPaused, setIsAppleSyncPaused] = useState(false);
  const [isConnectingOutlook, setIsConnectingOutlook] = useState(false);
  const [isConnectingApple, setIsConnectingApple] = useState(false);
  const [isUpdatingOutlookConnection, setIsUpdatingOutlookConnection] = useState(false);
  const [isUpdatingAppleConnection, setIsUpdatingAppleConnection] = useState(false);
  const [showCalendarSyncEditor, setShowCalendarSyncEditor] = useState(false);
  const [isSavingCalendarSync, setIsSavingCalendarSync] = useState(false);
  const [isConnectingGoogle, setIsConnectingGoogle] = useState(false);
  const [isUpdatingGoogleConnection, setIsUpdatingGoogleConnection] = useState(false);
  const [isPushingGoogleCalendar, setIsPushingGoogleCalendar] = useState(false);
  const [isPushingAppleCalendar, setIsPushingAppleCalendar] = useState(false);
  const [showContactsModal, setShowContactsModal] = useState(false);
  const [contacts, setContacts] = useState<AccountContact[]>([]);
  const [contactGroups, setContactGroups] = useState<ContactGroup[]>([]);
  const [contactsLastSyncedAt, setContactsLastSyncedAt] = useState<string | null>(null);
  const [activeContactsView, setActiveContactsView] = useState<ContactsView>('none');
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [contactsMessage, setContactsMessage] = useState<string | null>(null);
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactDraft, setContactDraft] = useState(createEmptyContactDraft());
  const [contactAddressLine1, setContactAddressLine1] = useState('');
  const [contactAddressLine2, setContactAddressLine2] = useState('');
  const [contactAddressCity, setContactAddressCity] = useState('');
  const [contactAddressState, setContactAddressState] = useState('');
  const [contactAddressZip, setContactAddressZip] = useState('');
  const [contactsDisplayMode, setContactsDisplayMode] = useState<ContactsDisplayMode>('summary');
  const [activeSummaryContactId, setActiveSummaryContactId] = useState<string | null>(null);
  const [contactAddressPredictions, setContactAddressPredictions] = useState<GoogleAddressPrediction[]>([]);
  const [contactAddressAutocompleteSessionToken] = useState(() => `addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const skipNextContactAutocompleteFetchRef = useRef(0);
  const isSelectingAccountAddressPredictionRef = useRef(false);
  const accountAddressBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [showCloneGroupModal, setShowCloneGroupModal] = useState(false);
  const [groupDeleteCandidateId, setGroupDeleteCandidateId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroupNameDraft, setSelectedGroupNameDraft] = useState('');
  const [selectedGroupDescriptionDraft, setSelectedGroupDescriptionDraft] = useState('');
  const [groupsDisplayMode, setGroupsDisplayMode] = useState<GroupsDisplayMode>('summary');
  const [selectedGroupMembersPage, setSelectedGroupMembersPage] = useState(0);
  const [selectedGroupAddContactsPage, setSelectedGroupAddContactsPage] = useState(0);
  const [groupMembersSearch, setGroupMembersSearch] = useState('');
  const [groupAddContactsSearch, setGroupAddContactsSearch] = useState('');
  const [groupNameSaveState, setGroupNameSaveState] = useState<'idle' | 'saved'>('idle');
  const [groupDescriptionSaveState, setGroupDescriptionSaveState] = useState<'idle' | 'saved'>('idle');
  const [contactsPage, setContactsPage] = useState(0);
  const [selectedContactIdToAdd, setSelectedContactIdToAdd] = useState('');
  const [showContactSupportModal, setShowContactSupportModal] = useState(false);
  const [contactSupportSubject, setContactSupportSubject] = useState('');
  const [contactSupportMessage, setContactSupportMessage] = useState('');
  const [contactSupportError, setContactSupportError] = useState<string | null>(null);
  const [isSendingContactSupport, setIsSendingContactSupport] = useState(false);
  const [showDeviceContactsImportModal, setShowDeviceContactsImportModal] = useState(false);
  const [deviceContactsToImport, setDeviceContactsToImport] = useState<DeviceContactImportCandidate[]>([]);
  const [isLoadingDeviceContacts, setIsLoadingDeviceContacts] = useState(false);
  const [deliveryDevice, setDeliveryDevice] = useState(true);
  const [deliveryEmail, setDeliveryEmail] = useState(false);
  const [deliveryText, setDeliveryText] = useState(false);
  const [isMobileNumberVerified, setIsMobileNumberVerified] = useState(Boolean(user.mobileNumberVerified));
  const [showMobileVerificationModal, setShowMobileVerificationModal] = useState(false);
  const [mobileVerificationCode, setMobileVerificationCode] = useState('');
  const [isMobileVerificationSubmitting, setIsMobileVerificationSubmitting] = useState(false);
  const [activeAccountAction, setActiveAccountAction] = useState<AccountAction>('none');
  const activeContacts = useMemo(() => contacts, [contacts]);
  const favoriteContacts = useMemo(() => activeContacts.filter((entry) => entry.isFavorite), [activeContacts]);
  const visibleContacts = useMemo(() => {
    if (activeContactsView === 'favorites') {
      return favoriteContacts;
    }
    return activeContacts;
  }, [activeContacts, activeContactsView, favoriteContacts]);
  const activeSummaryContact = useMemo(
    () => contacts.find((entry) => entry.id === activeSummaryContactId) || null,
    [activeSummaryContactId, contacts],
  );
  const selectedGroup = useMemo(() => contactGroups.find((entry) => entry.id === selectedGroupId) || null, [contactGroups, selectedGroupId]);
  const getGroupMemberCount = useCallback((group: ContactGroup) => (
    group.contactIds.filter((contactId) => activeContacts.some((entry) => entry.id === contactId)).length
  ), [activeContacts]);
  const selectedGroupMembers = useMemo(() => {
    if (!selectedGroup) {
      return [] as AccountContact[];
    }

    return selectedGroup.contactIds
      .map((contactId) => activeContacts.find((entry) => entry.id === contactId) || null)
      .filter((entry): entry is AccountContact => entry !== null);
  }, [activeContacts, selectedGroup]);
  const filteredSelectedGroupMembers = useMemo(() => {
    const query = groupMembersSearch.trim().toLowerCase();
    if (!query) {
      return selectedGroupMembers;
    }

    return selectedGroupMembers.filter((entry) => {
      const displayName = getContactDisplayName(entry).toLowerCase();
      const email = (entry.email || '').toLowerCase();
      const mobile = (entry.mobileNumber || '').toLowerCase();
      return displayName.includes(query) || email.includes(query) || mobile.includes(query);
    });
  }, [getContactDisplayName, groupMembersSearch, selectedGroupMembers]);
  const contactsAvailableForSelectedGroup = useMemo(() => {
    if (!selectedGroup) {
      return [] as AccountContact[];
    }

    return activeContacts.filter((entry) => !selectedGroup.contactIds.includes(entry.id));
  }, [activeContacts, selectedGroup]);
  const filteredContactsAvailableForSelectedGroup = useMemo(() => {
    const query = groupAddContactsSearch.trim().toLowerCase();
    if (!query) {
      return contactsAvailableForSelectedGroup;
    }

    return contactsAvailableForSelectedGroup.filter((entry) => {
      const displayName = getContactDisplayName(entry).toLowerCase();
      const email = (entry.email || '').toLowerCase();
      const mobile = (entry.mobileNumber || '').toLowerCase();
      return displayName.includes(query) || email.includes(query) || mobile.includes(query);
    });
  }, [contactsAvailableForSelectedGroup, getContactDisplayName, groupAddContactsSearch]);
  const selectedGroupMembersPageSize = 5;
  const selectedGroupMembersPageCount = Math.max(1, Math.ceil(filteredSelectedGroupMembers.length / selectedGroupMembersPageSize));
  const selectedGroupAddContactsPageCount = Math.max(1, Math.ceil(filteredContactsAvailableForSelectedGroup.length / selectedGroupMembersPageSize));
  const contactsPageSize = 12;
  const contactsPageCount = Math.max(1, Math.ceil(visibleContacts.length / contactsPageSize));
  const contactsPageItems = useMemo(() => {
    const startIndex = contactsPage * contactsPageSize;
    return visibleContacts.slice(startIndex, startIndex + contactsPageSize);
  }, [contactsPage, visibleContacts]);
  const selectedGroupMembersPageItems = useMemo(() => {
    const startIndex = selectedGroupMembersPage * selectedGroupMembersPageSize;
    return filteredSelectedGroupMembers.slice(startIndex, startIndex + selectedGroupMembersPageSize);
  }, [filteredSelectedGroupMembers, selectedGroupMembersPage]);
  const selectedGroupAddContactsPageItems = useMemo(() => {
    const startIndex = selectedGroupAddContactsPage * selectedGroupMembersPageSize;
    return filteredContactsAvailableForSelectedGroup.slice(startIndex, startIndex + selectedGroupMembersPageSize);
  }, [filteredContactsAvailableForSelectedGroup, selectedGroupAddContactsPage]);
  const activeContactEmails = useMemo(
    () => new Set(activeContacts.map((entry) => entry.email.trim().toLowerCase()).filter(Boolean)),
    [activeContacts],
  );
  const activeContactPhones = useMemo(
    () => new Set(activeContacts.map((entry) => normalizePhoneDigits(entry.mobileNumber || '')).filter(Boolean)),
    [activeContacts],
  );
  const contactsLastSyncedLabel = useMemo(() => {
    if (!contactsLastSyncedAt) {
      return 'Last backup: pending';
    }

    const parsedDate = new Date(contactsLastSyncedAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return 'Last backup: pending';
    }

    return `Last backup: ${parsedDate.toLocaleString()}`;
  }, [contactsLastSyncedAt]);
  const isImportCandidateAlreadySaved = useCallback((entry: DeviceContactImportCandidate) => (
    (entry.email && activeContactEmails.has(entry.email.trim().toLowerCase()))
      || (entry.mobileNumber && activeContactPhones.has(normalizePhoneDigits(entry.mobileNumber)))
  ), [activeContactEmails, activeContactPhones]);
  const deviceContactsImportRows = useMemo<Array<DeviceContactImportCandidate & { alreadyAdded: boolean }>>(() => (
    deviceContactsToImport.map((entry) => ({
      ...entry,
      alreadyAdded: Boolean(isImportCandidateAlreadySaved(entry)),
    }))
  ), [deviceContactsToImport, isImportCandidateAlreadySaved]);
  const importableDeviceContactsCount = useMemo(
    () => deviceContactsImportRows.filter((entry) => !entry.alreadyAdded).length,
    [deviceContactsImportRows],
  );

  useEffect(() => {
    setSelectedGroupNameDraft(selectedGroup?.name || '');
    setSelectedGroupDescriptionDraft(selectedGroup?.description || '');
  }, [selectedGroup?.description, selectedGroup?.id, selectedGroup?.name]);

  useEffect(() => {
    setSelectedGroupMembersPage(0);
    setSelectedGroupAddContactsPage(0);
  }, [selectedGroupId, groupsDisplayMode]);

  useEffect(() => {
    setContactsPage(0);
  }, [activeContactsView, contacts.length, favoriteContacts.length]);

  useEffect(() => {
    if (contactsPage >= contactsPageCount) {
      setContactsPage(Math.max(0, contactsPageCount - 1));
    }
  }, [contactsPage, contactsPageCount]);

  useEffect(() => {
    if (selectedGroupMembersPage >= selectedGroupMembersPageCount) {
      setSelectedGroupMembersPage(Math.max(0, selectedGroupMembersPageCount - 1));
    }
  }, [selectedGroupMembersPage, selectedGroupMembersPageCount]);

  useEffect(() => {
    if (selectedGroupAddContactsPage >= selectedGroupAddContactsPageCount) {
      setSelectedGroupAddContactsPage(Math.max(0, selectedGroupAddContactsPageCount - 1));
    }
  }, [selectedGroupAddContactsPage, selectedGroupAddContactsPageCount]);

  useEffect(() => {
    if (!selectedGroup || groupsDisplayMode !== 'manage') {
      setSelectedContactIdToAdd('');
      return;
    }

    if (!contactsAvailableForSelectedGroup.length) {
      setSelectedContactIdToAdd('');
      return;
    }

    setSelectedContactIdToAdd((current) => (
      current && contactsAvailableForSelectedGroup.some((entry) => entry.id === current)
        ? current
        : contactsAvailableForSelectedGroup[0].id
    ));
  }, [contactsAvailableForSelectedGroup, groupsDisplayMode, selectedGroup]);

  useEffect(() => () => {
    if (accountAddressBlurTimeoutRef.current) {
      clearTimeout(accountAddressBlurTimeoutRef.current);
    }
  }, []);
  const isAppleLocalSyncSupported = Platform.OS === 'ios';
  const isGoogleConfigured = Boolean(googleCalendarId.trim());
  const googleSyncStatus: 'not-synched' | 'synched' | 'paused' | 'disconnected' = !isGoogleConfigured
    ? 'not-synched'
    : isGoogleSyncPaused
      ? 'paused'
      : isGoogleConnected
        ? 'synched'
        : 'disconnected';
  const isOutlookConfigured = Boolean(outlookCalendarEmail.trim());
  const outlookSyncStatus: 'not-synched' | 'synched' | 'paused' | 'disconnected' = !isOutlookConfigured
    ? 'not-synched'
    : isOutlookSyncPaused
      ? 'paused'
      : isOutlookConnected
        ? 'synched'
        : 'disconnected';
  const isAppleConfigured = Boolean(appleCalendarId.trim());
  const appleSyncStatus: 'not-synched' | 'synched' | 'paused' | 'disconnected' = !isAppleConfigured
    ? 'not-synched'
    : isAppleSyncPaused
      ? 'paused'
      : isAppleConnected
        ? 'synched'
        : 'disconnected';

  useEffect(() => {
    let isActive = true;
    const query = addressLine1.trim();

    if (!isAccountAddressLine1Focused) {
      setAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (query.length < 4) {
      setAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (skipNextAccountAutocompleteFetchRef.current > 0) {
      skipNextAccountAutocompleteFetchRef.current -= 1;
      setAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    const timeoutId = setTimeout(() => {
      void findGoogleAddressPredictions(query, addressAutocompleteSessionToken).then((predictions) => {
        if (isActive) {
          setAddressPredictions(predictions);
        }
      });
    }, 250);

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [addressAutocompleteSessionToken, addressLine1, isAccountAddressLine1Focused]);

  useEffect(() => {
    let isActive = true;
    const query = contactAddressLine1.trim();

    if (query.length < 4) {
      setContactAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    if (skipNextContactAutocompleteFetchRef.current > 0) {
      skipNextContactAutocompleteFetchRef.current -= 1;
      setContactAddressPredictions([]);
      return () => {
        isActive = false;
      };
    }

    const timeoutId = setTimeout(() => {
      void findGoogleAddressPredictions(query, contactAddressAutocompleteSessionToken).then((predictions) => {
        if (isActive) {
          setContactAddressPredictions(predictions);
        }
      });
    }, 250);

    return () => {
      isActive = false;
      clearTimeout(timeoutId);
    };
  }, [contactAddressAutocompleteSessionToken, contactAddressLine1]);

  const applyAccountAddressPrediction = useCallback(async (prediction: GoogleAddressPrediction) => {
    skipNextAccountAutocompleteFetchRef.current = 2;
    isSelectingAccountAddressPredictionRef.current = false;
    setAddressPredictions([]);
    setIsAccountAddressLine1Focused(false);
    setAddressLine1(prediction.mainText || prediction.description || '');

    const resolved = await resolveGoogleAddressPrediction(prediction.placeId, addressAutocompleteSessionToken);
    const nextLine1 = resolved?.line1 || prediction.mainText || prediction.description;

    setAddressLine1(nextLine1);
    if (resolved) {
      setAddressCity(resolved.city || '');
      setAddressState(resolved.state || '');
      setAddressZip(resolved.zip || '');
    }

    if (message) {
      setMessage(null);
    }
  }, [addressAutocompleteSessionToken, message]);

  const applyContactAddressPrediction = useCallback(async (prediction: GoogleAddressPrediction) => {
    skipNextContactAutocompleteFetchRef.current = 2;
    setContactAddressPredictions([]);
    setContactAddressLine1(prediction.mainText || prediction.description || '');

    const resolved = await resolveGoogleAddressPrediction(prediction.placeId, contactAddressAutocompleteSessionToken);
    const nextLine1 = resolved?.line1 || prediction.mainText || prediction.description;

    setContactAddressLine1(nextLine1);
    if (resolved) {
      setContactAddressCity(resolved.city || '');
      setContactAddressState(resolved.state || '');
      setContactAddressZip(resolved.zip || '');
    }

    if (contactsMessage) {
      setContactsMessage(null);
    }
  }, [contactAddressAutocompleteSessionToken, contactsMessage]);

  const refreshGoogleConnectionStatus = useCallback(async () => {
    if (!isGoogleConfigured) {
      setIsGoogleConnected(false);
      return;
    }

    try {
      const status = await getGoogleConnectionStatus(user.id);
      if (!status.connected) {
        await clearGoogleCalendarAssociation();
        return;
      }
      setIsGoogleConnected(true);
    } catch {
      setIsGoogleConnected(false);
    }
  }, [isGoogleConfigured, user.id]);

  const refreshOutlookConnectionStatus = useCallback(async () => {
    if (!isOutlookConfigured) {
      setIsOutlookConnected(false);
      return;
    }

    try {
      const status = await getOutlookConnectionStatus(user.id);
      if (!status.connected) {
        await clearOutlookCalendarAssociation();
        return;
      }
      setIsOutlookConnected(true);
    } catch {
      setIsOutlookConnected(false);
    }
  }, [isOutlookConfigured, user.id]);

  const loadAppleWritableCalendars = useCallback(async (requestPermission: boolean) => {
    if (!isAppleLocalSyncSupported) {
      setAppleAvailableCalendars([]);
      return [] as Array<{ id: string; title: string }>;
    }

    const permission = requestPermission
      ? await Calendar.requestCalendarPermissionsAsync()
      : await Calendar.getCalendarPermissionsAsync();

    if (permission.status !== 'granted') {
      setAppleAvailableCalendars([]);
      return [] as Array<{ id: string; title: string }>;
    }

    const writableCalendars = (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT))
      .filter((entry) => entry.allowsModifications !== false)
      .map((entry) => ({ id: entry.id, title: entry.title || 'Untitled calendar' }));

    setAppleAvailableCalendars(writableCalendars);

    const matchingDraft = writableCalendars.find((entry) => entry.id === appleCalendarIdDraft);
    const matchingConfigured = writableCalendars.find((entry) => entry.id === appleCalendarId);
    const seededCalendar = matchingDraft || matchingConfigured || null;

    if (seededCalendar) {
      setAppleCalendarIdDraft(seededCalendar.id);
      setAppleCalendarNameDraft(seededCalendar.title);
    }

    return writableCalendars;
  }, [appleCalendarId, appleCalendarIdDraft, isAppleLocalSyncSupported]);

  const refreshAppleConnectionStatus = useCallback(async () => {
    if (!isAppleConfigured) {
      setIsAppleConnected(false);
      return;
    }

    if (!isAppleLocalSyncSupported) {
      setIsAppleConnected(false);
      return;
    }

    try {
      const permission = await Calendar.getCalendarPermissionsAsync();
      if (permission.status !== 'granted') {
        await clearAppleCalendarAssociation();
        return;
      }

      const selectedCalendar = (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT))
        .find((entry) => entry.id === appleCalendarId && entry.allowsModifications !== false);
      if (!selectedCalendar) {
        await clearAppleCalendarAssociation();
        return;
      }

      if (selectedCalendar.title && selectedCalendar.title !== appleCalendarName) {
        setAppleCalendarName(selectedCalendar.title);
        setAppleCalendarIdDraft(selectedCalendar.id);
        setAppleCalendarNameDraft(selectedCalendar.title);
      }

      setIsAppleConnected(true);
    } catch (error) {
      // Avoid clearing a valid connected state due transient bridge/runtime errors.
      console.warn('Apple connection status refresh failed', error);
    }
  }, [appleCalendarId, appleCalendarName, isAppleConfigured, isAppleLocalSyncSupported]);

  useEffect(() => {
    setIsMobileNumberVerified(Boolean(user.mobileNumberVerified));
  }, [user.mobileNumberVerified]);

  useEffect(() => {
    (async () => {
      try {
        const settings = await loadReminderSoundSettings(user.id);
        setReminderSoundOff(!settings.enabled);
      } catch (error) {
        console.warn('Unable to load account reminder sound settings', error);
        setReminderSoundOff(false);
      }

      try {
        const delivery = await loadReminderDeliverySettings(user.id);
        setDeliveryDevice(delivery.device);
        setDeliveryEmail(delivery.email);
        setDeliveryText(delivery.text);
      } catch (error) {
        console.warn('Unable to load account reminder delivery settings', error);
        setDeliveryDevice(true);
        setDeliveryEmail(false);
        setDeliveryText(false);
      }

      try {
        const reminderTime = await loadReminderDefaultTimeSettings(user.id);
        const loadedInterval = normalizeClockIntervalMinutes(reminderTime.clockIntervalMinutes);
        const loadedMinute = alignMinuteToClockInterval(reminderTime.minute, loadedInterval);
        setDefaultReminderHour(reminderTime.hour);
        setDefaultReminderMinute(loadedMinute);
        setDefaultReminderDraftHour(reminderTime.hour);
        setDefaultReminderDraftMinute(loadedMinute);
        setDefaultReminderClockInterval(loadedInterval);
        setDefaultReminderDraftClockInterval(loadedInterval);
      } catch (error) {
        console.warn('Unable to load account default reminder time settings', error);
        setDefaultReminderHour(9);
        setDefaultReminderMinute(0);
        setDefaultReminderDraftHour(9);
        setDefaultReminderDraftMinute(0);
        setDefaultReminderClockInterval(5);
        setDefaultReminderDraftClockInterval(5);
      }

      try {
        const reminderTimeZoneSettings = await loadReminderTimeZoneSettings(user.id);
        setDefaultReminderTimeZone(reminderTimeZoneSettings.timeZone);
        setDefaultReminderTimeZoneDraft(reminderTimeZoneSettings.timeZone);
        onReminderTimeZoneUpdated(reminderTimeZoneSettings.timeZone);
      } catch (error) {
        console.warn('Unable to load account default reminder time zone settings', error);
        const fallbackTimeZone = getDeviceTimeZone();
        setDefaultReminderTimeZone(fallbackTimeZone);
        setDefaultReminderTimeZoneDraft(fallbackTimeZone);
        onReminderTimeZoneUpdated(fallbackTimeZone);
      }

      try {
        const calendarSyncSettings = await loadCalendarSyncSettings(user.id);
        setCalendarSyncProviderDraft('none');
        setGoogleCalendarPermission('write');
        setGoogleCalendarId(calendarSyncSettings.google.calendarId || '');
        setGoogleCalendarIdDraft(calendarSyncSettings.google.calendarId || '');
        setIsGoogleSyncPaused(calendarSyncSettings.google.syncPaused === true);
        setIsGoogleAutoSyncEnabled(calendarSyncSettings.google.autoSyncEnabled !== false);
        setOutlookCalendarEmail(calendarSyncSettings.outlook.email || '');
        setOutlookCalendarEmailDraft(calendarSyncSettings.outlook.email || '');
        setIsOutlookSyncPaused(calendarSyncSettings.outlook.syncPaused === true);
        setAppleCalendarId(calendarSyncSettings.apple.appleId || '');
        setAppleCalendarIdDraft(calendarSyncSettings.apple.appleId || '');
        setAppleCalendarName(calendarSyncSettings.apple.calendarName || '');
        setAppleCalendarNameDraft(calendarSyncSettings.apple.calendarName || '');
        setIsAppleSyncPaused(calendarSyncSettings.apple.syncPaused === true);
      } catch (error) {
        console.warn('Unable to load account calendar sync settings', error);
        setCalendarSyncProviderDraft('none');
        setIsGoogleSyncPaused(false);
        setIsGoogleAutoSyncEnabled(true);
        setOutlookCalendarEmail('');
        setOutlookCalendarEmailDraft('');
        setIsOutlookSyncPaused(false);
        setAppleCalendarId('');
        setAppleCalendarIdDraft('');
        setAppleCalendarName('');
        setAppleCalendarNameDraft('');
        setIsAppleSyncPaused(false);
      }

      await Promise.all([
        refreshGoogleConnectionStatus(),
        refreshOutlookConnectionStatus(),
        refreshAppleConnectionStatus(),
      ]);
    })();
  }, [user.id, onReminderTimeZoneUpdated, refreshGoogleConnectionStatus, refreshOutlookConnectionStatus, refreshAppleConnectionStatus]);

  const openCalendarSyncEditor = (provider: CalendarSyncProvider) => {
    setCalendarSyncProviderDraft(provider);
    if (provider === 'google') {
      const seededGoogleId = googleCalendarId.trim() || user.email.trim();
      setGoogleCalendarIdDraft(seededGoogleId);
    } else if (provider === 'outlook') {
      const seededOutlookEmail = outlookCalendarEmail.trim() || user.email.trim();
      setOutlookCalendarEmailDraft(seededOutlookEmail);
    } else if (provider === 'apple') {
      setAppleCalendarIdDraft(appleCalendarId);
      setAppleCalendarNameDraft(appleCalendarName);
      void loadAppleWritableCalendars(false);
    } else {
      setGoogleCalendarIdDraft(googleCalendarId);
    }
    setShowCalendarSyncEditor(true);
  };

  const buildCalendarSyncSettings = (overrides?: {
    provider?: CalendarSyncProvider;
    google?: Partial<{ calendarId: string; permission: CalendarSyncPermission; syncPaused: boolean; autoSyncEnabled: boolean }>;
    outlook?: Partial<{ email: string; syncPaused: boolean }>;
    apple?: Partial<{ appleId: string; calendarName: string; syncPaused: boolean }>;
  }) => ({
    provider: overrides?.provider ?? 'none' as CalendarSyncProvider,
    google: {
      calendarId: overrides?.google?.calendarId ?? googleCalendarId,
      permission: overrides?.google?.permission ?? 'write',
      syncPaused: overrides?.google?.syncPaused ?? isGoogleSyncPaused,
      autoSyncEnabled: overrides?.google?.autoSyncEnabled ?? isGoogleAutoSyncEnabled,
    },
    outlook: {
      email: overrides?.outlook?.email ?? outlookCalendarEmail,
      syncPaused: overrides?.outlook?.syncPaused ?? isOutlookSyncPaused,
    },
    apple: {
      appleId: overrides?.apple?.appleId ?? appleCalendarId,
      calendarName: overrides?.apple?.calendarName ?? appleCalendarName,
      syncPaused: overrides?.apple?.syncPaused ?? isAppleSyncPaused,
    },
  });

  const clearGoogleCalendarAssociation = useCallback(async () => {
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        google: {
          calendarId: '',
          permission: 'write',
          syncPaused: false,
        },
      }), user.id);
    } catch (error) {
      console.warn('Unable to clear Google calendar association', error);
    }

    setGoogleCalendarId('');
    setGoogleCalendarIdDraft('');
    setIsGoogleConnected(false);
    setIsGoogleSyncPaused(false);
    setIsGoogleAutoSyncEnabled(true);
  }, [buildCalendarSyncSettings, user.id]);

  const handleToggleGoogleAutoSync = async () => {
    if (!isGoogleConnected) {
      setMessage('Connect Google first to manage auto-sync.');
      return;
    }

    const nextAutoSyncEnabled = !isGoogleAutoSyncEnabled;
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        google: {
          autoSyncEnabled: nextAutoSyncEnabled,
        },
      }), user.id);
      setIsGoogleAutoSyncEnabled(nextAutoSyncEnabled);
    } catch (error) {
      console.warn('Unable to update Google auto-sync preference', error);
      setMessage('Unable to update Google auto-sync preference right now.');
    }
  };

  const clearOutlookCalendarAssociation = useCallback(async () => {
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        outlook: {
          email: '',
          syncPaused: false,
        },
      }), user.id);
    } catch (error) {
      console.warn('Unable to clear Outlook calendar association', error);
    }

    setOutlookCalendarEmail('');
    setOutlookCalendarEmailDraft('');
    setIsOutlookConnected(false);
    setIsOutlookSyncPaused(false);
  }, [buildCalendarSyncSettings, user.id]);

  const clearAppleCalendarAssociation = useCallback(async () => {
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        provider: 'none',
        apple: {
          appleId: '',
          calendarName: '',
          syncPaused: false,
        },
      }), user.id);
    } catch (error) {
      console.warn('Unable to clear Apple calendar association', error);
    }

    setCalendarSyncProviderDraft('none');
    setAppleCalendarId('');
    setAppleCalendarIdDraft('');
    setAppleCalendarName('');
    setAppleCalendarNameDraft('');
    setAppleAvailableCalendars([]);
    setIsAppleConnected(false);
    setIsAppleSyncPaused(false);
  }, [buildCalendarSyncSettings, user.id]);

  useEffect(() => {
    void refreshGoogleConnectionStatus();
    const intervalId = setInterval(() => {
      void refreshGoogleConnectionStatus();
    }, 12000);

    return () => clearInterval(intervalId);
  }, [refreshGoogleConnectionStatus]);

  useEffect(() => {
    void refreshOutlookConnectionStatus();
    const intervalId = setInterval(() => {
      void refreshOutlookConnectionStatus();
    }, 12000);

    return () => clearInterval(intervalId);
  }, [refreshOutlookConnectionStatus]);

  useEffect(() => {
    void refreshAppleConnectionStatus();
    const intervalId = setInterval(() => {
      void refreshAppleConnectionStatus();
    }, 12000);

    return () => clearInterval(intervalId);
  }, [refreshAppleConnectionStatus]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }

    const refreshOnReturnToApp = () => {
      void refreshGoogleConnectionStatus();
      void refreshOutlookConnectionStatus();
      void refreshAppleConnectionStatus();
    };

    const refreshOnVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshOnReturnToApp();
      }
    };

    window.addEventListener('focus', refreshOnReturnToApp);
    document.addEventListener('visibilitychange', refreshOnVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshOnReturnToApp);
      document.removeEventListener('visibilitychange', refreshOnVisibilityChange);
    };
  }, [refreshGoogleConnectionStatus, refreshOutlookConnectionStatus, refreshAppleConnectionStatus]);

  const startGoogleConnection = async (googleId: string, saveAsConfigured: boolean) => {
    const normalizedGoogleId = googleId.trim();
    if (!normalizedGoogleId) {
      setMessage('Enter your Google ID before connecting.');
      return;
    }

    setIsConnectingGoogle(true);
    try {
      let googleAlreadyConnected = false;
      try {
        const currentStatus = await getGoogleConnectionStatus(user.id);
        googleAlreadyConnected = currentStatus.connected === true;
      } catch {
        googleAlreadyConnected = false;
      }

      if (googleAlreadyConnected) {
        if (saveAsConfigured) {
          await saveCalendarSyncSettings(buildCalendarSyncSettings({
            google: {
              calendarId: normalizedGoogleId,
              permission: 'write',
              syncPaused: false,
            },
          }), user.id);

          setCalendarSyncProviderDraft('google');
          setGoogleCalendarId(normalizedGoogleId);
          setGoogleCalendarIdDraft(normalizedGoogleId);
          setIsGoogleSyncPaused(false);
        }

        setIsGoogleConnected(true);
        setShowCalendarSyncEditor(false);
        setMessage('Google account is already connected. Calendar ID was updated.');
        return;
      }

      if (saveAsConfigured) {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          google: {
            calendarId: normalizedGoogleId,
            permission: 'write',
            syncPaused: false,
          },
        }), user.id);

        setCalendarSyncProviderDraft('google');
        setGoogleCalendarId(normalizedGoogleId);
        setGoogleCalendarIdDraft(normalizedGoogleId);
        setIsGoogleSyncPaused(false);
      }

      const connectResult = await getGoogleAuthorizationConnectUrl(user.id, 'write', normalizedGoogleId);
      if (!connectResult.success || !connectResult.authUrl) {
        setMessage('Unable to start Google authorization flow. Verify backend OAuth settings.');
        return;
      }

      const canOpen = await Linking.canOpenURL(connectResult.authUrl);
      if (!canOpen) {
        setMessage('Unable to open Google authorization page on this device.');
        return;
      }

      await Linking.openURL(connectResult.authUrl);
      setShowCalendarSyncEditor(false);
      setMessage('Google authorization page opened. Complete sign-in and approval to finish connecting.');
    } catch (error) {
      console.warn('Google authorization start failed', error);
      setMessage('Unable to start Google authorization right now.');
    } finally {
      setIsConnectingGoogle(false);
    }
  };

  const handleConnectGoogle = async () => {
    await startGoogleConnection(googleCalendarIdDraft, true);
  };

  const startOutlookConnection = async (email: string, saveAsConfigured: boolean) => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setMessage('Enter your Outlook email before connecting.');
      return;
    }

    setIsConnectingOutlook(true);
    try {
      if (saveAsConfigured) {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          outlook: {
            email: normalizedEmail,
            syncPaused: false,
          },
        }), user.id);

        setCalendarSyncProviderDraft('outlook');
        setOutlookCalendarEmail(normalizedEmail);
        setOutlookCalendarEmailDraft(normalizedEmail);
        setIsOutlookSyncPaused(false);
      }

      const connectResult = await getOutlookAuthorizationConnectUrl(user.id, normalizedEmail);
      if (!connectResult.success || !connectResult.authUrl) {
        setMessage('Unable to start Outlook authorization flow. Verify backend OAuth settings.');
        return;
      }

      const canOpen = await Linking.canOpenURL(connectResult.authUrl);
      if (!canOpen) {
        setMessage('Unable to open Outlook authorization page on this device.');
        return;
      }

      await Linking.openURL(connectResult.authUrl);
      setShowCalendarSyncEditor(false);
      setMessage('Outlook authorization page opened. Complete sign-in and approval to finish connecting.');
    } catch (error) {
      console.warn('Outlook authorization start failed', error);
      setMessage('Unable to start Outlook authorization right now.');
    } finally {
      setIsConnectingOutlook(false);
    }
  };

  const handleConnectOutlook = async () => {
    await startOutlookConnection(outlookCalendarEmailDraft, true);
  };

  const startAppleConnection = async (calendarId: string, saveAsConfigured: boolean) => {
    const normalizedCalendarId = calendarId.trim();

    if (!isAppleLocalSyncSupported) {
      const platformMessage = `Apple iCalendar sync is only available on iOS devices. Current platform: ${Platform.OS}.`;
      setMessage(platformMessage);
      Alert.alert('Apple sync unavailable', platformMessage);
      return;
    }

    setIsConnectingApple(true);
    try {
      try {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          provider: 'none',
          apple: {
            appleId: '',
            calendarName: '',
            syncPaused: false,
          },
        }), user.id);
      } catch (error) {
        console.warn('Unable to reset Apple calendar state before reconnecting', error);
      }

      setCalendarSyncProviderDraft('apple');
      setAppleCalendarId('');
      setAppleCalendarIdDraft('');
      setAppleCalendarName('');
      setAppleCalendarNameDraft('');
      setIsAppleConnected(false);
      setIsAppleSyncPaused(false);

      const writableCalendars = await loadAppleWritableCalendars(true);
      if (writableCalendars.length === 0) {
        const permissionMessage = 'Calendar permission is required to connect Apple sync on iOS.';
        setMessage(permissionMessage);
        Alert.alert('Calendar permission needed', permissionMessage);
        return;
      }

      let selectedCalendar = writableCalendars.find((entry) => entry.id === normalizedCalendarId);

      if (!selectedCalendar && writableCalendars.length === 1) {
        selectedCalendar = writableCalendars[0];
      }

      if (!selectedCalendar) {
        const calendarMessage = 'Select the Apple calendar you want to connect, then tap Connect again.';
        if (writableCalendars[0]) {
          setAppleCalendarIdDraft(writableCalendars[0].id);
          setAppleCalendarNameDraft(writableCalendars[0].title);
        }
        setMessage(calendarMessage);
        return;
      }

      let settingsSaveFailed = false;
      if (saveAsConfigured) {
        try {
          await saveCalendarSyncSettings(buildCalendarSyncSettings({
            provider: 'apple',
            apple: {
              appleId: selectedCalendar.id,
              calendarName: selectedCalendar.title,
              syncPaused: false,
            },
          }), user.id);
        } catch (error) {
          settingsSaveFailed = true;
          console.warn('Apple sync settings save failed after local calendar selection', error);
        }
      }

      setCalendarSyncProviderDraft('apple');
      setAppleCalendarId(selectedCalendar.id);
      setAppleCalendarIdDraft(selectedCalendar.id);
      setAppleCalendarName(selectedCalendar.title);
      setAppleCalendarNameDraft(selectedCalendar.title);
      setIsAppleSyncPaused(false);
      setIsAppleConnected(true);
      setShowCalendarSyncEditor(false);
      if (settingsSaveFailed) {
        setMessage(`Apple calendar was selected on this device (${selectedCalendar.title}), but the sync settings could not be saved.`);
      } else {
        setMessage(`Apple calendar connected: ${selectedCalendar.title}.`);
      }
      void refreshAppleConnectionStatus();
    } catch (error) {
      console.warn('Apple connection failed', error);
      const reason = error instanceof Error && error.message ? `\n\nDetails: ${error.message}` : '';
      Alert.alert('Apple connection failed', `Unable to connect Apple Calendar right now.${reason}`);
      setMessage('Unable to connect Apple Calendar right now.');
    } finally {
      setIsConnectingApple(false);
    }
  };

  const handleConnectApple = async () => {
    await startAppleConnection(appleCalendarIdDraft, true);
  };

  const handleConnectGoogleFromSection = async () => {
    if (googleSyncStatus === 'not-synched' || googleSyncStatus === 'disconnected') {
      openCalendarSyncEditor('google');
      return;
    }

    if (isGoogleSyncPaused && isGoogleConnected) {
      try {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          google: {
            syncPaused: false,
          },
        }), user.id);
        setIsGoogleSyncPaused(false);
        setMessage('Google calendar sync resumed.');
      } catch (error) {
        console.warn('Unable to resume Google sync', error);
        setMessage('Unable to resume Google calendar sync right now.');
      }
      return;
    }

    await startGoogleConnection(googleCalendarId, true);
  };

  const handleConnectOutlookFromSection = async () => {
    if (outlookSyncStatus === 'not-synched' || outlookSyncStatus === 'disconnected') {
      openCalendarSyncEditor('outlook');
      return;
    }

    if (isOutlookSyncPaused && isOutlookConnected) {
      try {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          outlook: {
            syncPaused: false,
          },
        }), user.id);
        setIsOutlookSyncPaused(false);
        setMessage('Outlook calendar sync resumed.');
      } catch (error) {
        console.warn('Unable to resume Outlook sync', error);
        setMessage('Unable to resume Outlook calendar sync right now.');
      }
      return;
    }

    await startOutlookConnection(outlookCalendarEmail, true);
  };

  const handleConnectAppleFromSection = async () => {
    if (!isAppleLocalSyncSupported) {
      setMessage(`Apple iCalendar sync is only available on iOS devices. Current platform: ${Platform.OS}.`);
      return;
    }

    if (appleSyncStatus === 'not-synched' || appleSyncStatus === 'disconnected') {
      openCalendarSyncEditor('apple');
      return;
    }

    if (isAppleSyncPaused && isAppleConnected) {
      try {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          apple: {
            syncPaused: false,
          },
        }), user.id);
        setIsAppleSyncPaused(false);
        setMessage('Apple calendar sync resumed.');
      } catch (error) {
        console.warn('Unable to resume Apple sync', error);
        setMessage('Unable to resume Apple calendar sync right now.');
      }
      return;
    }

    openCalendarSyncEditor('apple');
  };

  const handleCalendarSyncEditorConnect = async () => {
    if (calendarSyncProviderDraft === 'google') {
      await handleConnectGoogle();
      return;
    }

    if (calendarSyncProviderDraft === 'outlook') {
      await handleConnectOutlook();
      return;
    }

    if (calendarSyncProviderDraft === 'apple') {
      await handleConnectApple();
      return;
    }

    Alert.alert('Select provider', 'Please select a calendar provider before connecting.');
    setMessage('Please select a calendar provider before connecting.');
  };

  const handlePauseGoogle = async () => {
    if (!isGoogleConfigured) {
      setMessage('Google calendar is not configured yet.');
      return;
    }

    setIsUpdatingGoogleConnection(true);
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        google: {
          syncPaused: true,
        },
      }), user.id);
      setIsGoogleSyncPaused(true);
      setMessage('Google calendar sync is paused.');
    } catch (error) {
      console.warn('Google pause failed', error);
      setMessage('Unable to pause Google calendar sync right now.');
    } finally {
      setIsUpdatingGoogleConnection(false);
    }
  };

  const handlePauseOutlook = async () => {
    if (!isOutlookConfigured) {
      setMessage('Outlook calendar is not configured yet.');
      return;
    }

    setIsUpdatingOutlookConnection(true);
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        outlook: {
          syncPaused: true,
        },
      }), user.id);
      setIsOutlookSyncPaused(true);
      setMessage('Outlook calendar sync is paused.');
    } catch (error) {
      console.warn('Outlook pause failed', error);
      setMessage('Unable to pause Outlook calendar sync right now.');
    } finally {
      setIsUpdatingOutlookConnection(false);
    }
  };

  const handlePauseApple = async () => {
    if (!isAppleConfigured) {
      setMessage('Apple calendar is not configured yet.');
      return;
    }

    setIsUpdatingAppleConnection(true);
    try {
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        apple: {
          syncPaused: true,
        },
      }), user.id);
      setIsAppleSyncPaused(true);
      setMessage('Apple calendar sync is paused.');
    } catch (error) {
      console.warn('Apple pause failed', error);
      setMessage('Unable to pause Apple calendar sync right now.');
    } finally {
      setIsUpdatingAppleConnection(false);
    }
  };

  const handleRemoveGoogleConnection = async () => {
    setIsUpdatingGoogleConnection(true);
    try {
      await disconnectGoogleCalendarConnection(user.id);
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        google: {
          calendarId: '',
          permission: 'write',
          syncPaused: false,
        },
      }), user.id);

      setCalendarSyncProviderDraft('none');
      setGoogleCalendarId('');
      setGoogleCalendarIdDraft('');
      setIsGoogleConnected(false);
      setIsGoogleSyncPaused(false);
      setShowCalendarSyncEditor(false);
      setMessage('Google calendar connection was removed.');
    } catch (error) {
      console.warn('Google connection removal failed', error);
      setMessage('Unable to remove Google calendar connection right now.');
    } finally {
      setIsUpdatingGoogleConnection(false);
    }
  };

  const handleRemoveOutlookConnection = async () => {
    setIsUpdatingOutlookConnection(true);
    try {
      await disconnectOutlookCalendarConnection(user.id);
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        outlook: {
          email: '',
          syncPaused: false,
        },
      }), user.id);

      setCalendarSyncProviderDraft('none');
      setOutlookCalendarEmail('');
      setOutlookCalendarEmailDraft('');
      setIsOutlookConnected(false);
      setIsOutlookSyncPaused(false);
      setShowCalendarSyncEditor(false);
      setMessage('Outlook calendar connection was removed.');
    } catch (error) {
      console.warn('Outlook connection removal failed', error);
      setMessage('Unable to remove Outlook calendar connection right now.');
    } finally {
      setIsUpdatingOutlookConnection(false);
    }
  };

  const handleRemoveAppleConnection = async () => {
    setIsUpdatingAppleConnection(true);
    try {
      await clearAppleCalendarAssociation();
      setShowCalendarSyncEditor(false);
      setMessage('Apple calendar connection was removed.');
    } catch (error) {
      console.warn('Apple connection removal failed', error);
      setMessage('Unable to remove Apple calendar connection right now.');
    } finally {
      setIsUpdatingAppleConnection(false);
    }
  };

  const handlePushGoogleCalendar = async () => {
    if (!googleCalendarId) {
      setMessage('Google sync requires a target Calendar ID.');
      return;
    }

    if (isGoogleSyncPaused) {
      setMessage('Google calendar sync is paused. Resume sync before pushing events.');
      return;
    }

    if (!isGoogleConnected) {
      setMessage('Google account is not connected yet. Open Google sync and connect first.');
      return;
    }

    setIsPushingGoogleCalendar(true);
    try {
      const result = await pushGoogleCalendarEvents(user.id);
      if (result.success) {
        setMessage(`Google push complete. Created: ${result.created}, Updated: ${result.updated}.`);
      } else {
        const firstError = result.errors[0] || 'Unknown sync error.';
        setMessage(`Google push finished with issues. Created: ${result.created}, Updated: ${result.updated}, Failed: ${result.failed}. ${firstError}`);
      }
    } catch (error) {
      console.warn('Google Calendar push failed', error);
      setMessage('Unable to push events to Google Calendar right now.');
    } finally {
      setIsPushingGoogleCalendar(false);
    }
  };

  const handlePushAppleCalendar = async () => {
    if (!appleCalendarId) {
      setMessage('Apple sync requires selecting a device calendar first.');
      return;
    }

    if (!isAppleLocalSyncSupported) {
      setMessage('Apple local calendar sync is available on iOS only.');
      return;
    }

    if (isAppleSyncPaused) {
      setMessage('Apple calendar sync is paused. Resume sync before syncing events.');
      return;
    }

    if (!isAppleConnected) {
      setMessage('Apple account is not connected yet. Open Apple sync and connect first.');
      return;
    }

    setIsPushingAppleCalendar(true);
    try {
      const permission = await Calendar.requestCalendarPermissionsAsync();
      if (permission.status !== 'granted') {
        setMessage('Calendar permission is required to sync Apple events.');
        return;
      }

      const events = await loadEvents(user.id);
      const markerPrefix = 'sdr://event/';
      const calendarWindowStart = new Date();
      calendarWindowStart.setFullYear(calendarWindowStart.getFullYear() - 2);
      const calendarWindowEnd = new Date();
      calendarWindowEnd.setFullYear(calendarWindowEnd.getFullYear() + 10);

      const existingCalendarEvents = await Calendar.getEventsAsync([appleCalendarId], calendarWindowStart, calendarWindowEnd);
      const managedCalendarEvents = existingCalendarEvents.filter((entry) => typeof entry.url === 'string' && entry.url.startsWith(markerPrefix));
      const managedBySpecialDateId = new Map<string, Calendar.Event>();

      managedCalendarEvents.forEach((entry) => {
        const mappedId = String(entry.url || '').slice(markerPrefix.length);
        if (mappedId) {
          managedBySpecialDateId.set(mappedId, entry);
        }
      });

      const nextEventIds = new Set<string>();
      let createdCount = 0;
      let updatedCount = 0;
      let removedCount = 0;
      let failedCount = 0;

      for (const event of events) {
        const specialDateId = String(event.id || '').trim();
        if (!specialDateId) {
          continue;
        }

        const eventDate = new Date(event.eventDateTime);
        if (Number.isNaN(eventDate.getTime())) {
          continue;
        }

        nextEventIds.add(specialDateId);

        const startDate = new Date(eventDate);
        const endDate = new Date(eventDate);
        const isAllDay = event.eventAllDay === true;

        if (isAllDay) {
          startDate.setHours(0, 0, 0, 0);
          endDate.setHours(0, 0, 0, 0);
          endDate.setDate(endDate.getDate() + 1);
        } else {
          endDate.setHours(endDate.getHours() + 1);
        }

        const recurrenceFrequency = (() => {
          if (event.frequency === 'daily') return Calendar.Frequency.DAILY;
          if (event.frequency === 'weekly') return Calendar.Frequency.WEEKLY;
          if (event.frequency === 'monthly') return Calendar.Frequency.MONTHLY;
          if (event.frequency === 'yearly') return Calendar.Frequency.YEARLY;
          return null;
        })();

        const eventPayload: Calendar.Event = {
          id: `${specialDateId}-calendar`,
          calendarId: appleCalendarId,
          title: event.title,
          notes: event.notes || '',
          location: event.people || '',
          startDate,
          endDate,
          allDay: isAllDay,
          url: `${markerPrefix}${specialDateId}`,
          timeZone: event.reminderTimeZone || getDeviceTimeZone(),
          availability: Calendar.Availability.BUSY,
          status: Calendar.EventStatus.CONFIRMED,
          recurrenceRule: recurrenceFrequency ? { frequency: recurrenceFrequency } : null,
          alarms: [],
        };

        const existingEvent = managedBySpecialDateId.get(specialDateId);

        try {
          if (existingEvent) {
            await Calendar.updateEventAsync(existingEvent.id, eventPayload);
            updatedCount += 1;
          } else {
            await Calendar.createEventAsync(appleCalendarId, eventPayload);
            createdCount += 1;
          }
        } catch (error) {
          console.warn('Apple calendar event sync failed', error);
          failedCount += 1;
        }
      }

      for (const existingEvent of managedCalendarEvents) {
        const mappedId = String(existingEvent.url || '').slice(markerPrefix.length);
        if (!mappedId || nextEventIds.has(mappedId)) {
          continue;
        }

        try {
          await Calendar.deleteEventAsync(existingEvent.id);
          removedCount += 1;
        } catch (error) {
          console.warn('Apple calendar event removal failed', error);
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        setMessage(`Apple sync finished with issues. Created: ${createdCount}, Updated: ${updatedCount}, Removed: ${removedCount}, Failed: ${failedCount}.`);
      } else {
        setMessage(`Apple sync complete. Created: ${createdCount}, Updated: ${updatedCount}, Removed: ${removedCount}.`);
      }
    } catch (error) {
      console.warn('Apple Calendar sync failed', error);
      setMessage('Unable to sync events to Apple Calendar right now.');
    } finally {
      setIsPushingAppleCalendar(false);
    }
  };

  const startMobileVerificationFlow = async () => {
    const normalizedMobile = mobileNumber.trim();
    if (!normalizedMobile) {
      setMessage('Add your mobile phone number before enabling text reminders.');
      return false;
    }

    const phoneError = validatePhoneNumber(normalizedMobile);
    if (phoneError) {
      setMessage(phoneError);
      return false;
    }

    const startResult = await startMobileVerification(user.id, normalizedMobile);
    if (!startResult.success) {
      setMessage(startResult.error || 'Unable to start mobile verification right now.');
      return false;
    }

    setShowMobileVerificationModal(true);
    setMobileVerificationCode('');
    setMessage('A verification code was sent by text. Enter it to enable text reminders.');
    return true;
  };

  const handleVerifyMobileCode = async () => {
    const code = mobileVerificationCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setMessage('Enter the 6-digit mobile verification code.');
      return;
    }

    setIsMobileVerificationSubmitting(true);
    const verifyResult = await verifyMobileVerificationCode(user.id, code);
    setIsMobileVerificationSubmitting(false);

    if (!verifyResult.success) {
      setMessage(verifyResult.error || 'Unable to verify mobile code right now.');
      return;
    }

    try {
      await saveReminderDeliverySettings({
        device: deliveryDevice,
        email: deliveryEmail,
        text: true,
      }, user.id);
      setDeliveryText(true);
      setIsMobileNumberVerified(true);
      setShowMobileVerificationModal(false);
      setMobileVerificationCode('');
      setMessage('Mobile phone validated. Text reminders are now enabled.');
    } catch (error) {
      console.warn('Unable to enable text reminders after mobile verification', error);
      setMessage('Mobile was verified, but text reminders could not be enabled right now.');
    }
  };

  const handleDeliveryToggle = async (type: 'device' | 'email' | 'text') => {
    const nextDevice = type === 'device' ? !deliveryDevice : deliveryDevice;
    const nextEmail = type === 'email' ? !deliveryEmail : deliveryEmail;
    const nextText = type === 'text' ? !deliveryText : deliveryText;

    if (type === 'text' && nextText && !isMobileNumberVerified) {
      setDeliveryText(false);
      await startMobileVerificationFlow();
      return;
    }

    setDeliveryDevice(nextDevice);
    setDeliveryEmail(nextEmail);
    setDeliveryText(nextText);

    try {
      await saveReminderDeliverySettings({
        device: nextDevice,
        email: nextEmail,
        text: nextText,
      }, user.id);
    } catch (error) {
      console.warn('Unable to save account reminder delivery settings', error);
      setDeliveryDevice(deliveryDevice);
      setDeliveryEmail(deliveryEmail);
      setDeliveryText(deliveryText);
      setMessage('Unable to update delivery preference right now.');
    }
  };

  const handleReminderSoundOffToggle = async () => {
    const nextValue = !reminderSoundOff;
    setReminderSoundOff(nextValue);

    try {
      await saveReminderSoundSettings({
        enabled: !nextValue,
        pattern: 'double',
        volume: 'loud',
      }, user.id);
    } catch (error) {
      console.warn('Unable to save account reminder sound settings', error);
      setReminderSoundOff(!nextValue);
      setMessage('Unable to update reminder sound preference right now.');
    }
  };

  const handleSaveDefaultReminderTime = async (override?: { hour: number; minute: number }) => {
    setIsSavingDefaultReminderTime(true);
    const nextInterval = normalizeClockIntervalMinutes(defaultReminderDraftClockInterval);
    const nextHour = override?.hour ?? defaultReminderDraftHour;
    const draftMinute = override?.minute ?? defaultReminderDraftMinute;
    const nextMinute = alignMinuteToClockInterval(draftMinute, nextInterval);

    try {
      await saveReminderDefaultTimeSettings({
        hour: nextHour,
        minute: nextMinute,
        clockIntervalMinutes: nextInterval,
      }, user.id);
      setDefaultReminderHour(nextHour);
      setDefaultReminderMinute(nextMinute);
      setDefaultReminderDraftHour(nextHour);
      setDefaultReminderDraftMinute(nextMinute);
      setDefaultReminderClockInterval(nextInterval);
      setDefaultReminderDraftClockInterval(nextInterval);
      setShowDefaultReminderTimeEditor(false);
      setMessage('Default reminder time updated.');
    } catch (error) {
      console.warn('Unable to save account default reminder time settings', error);
      setMessage('Unable to update default reminder time right now.');
    } finally {
      setIsSavingDefaultReminderTime(false);
    }
  };

  const defaultReminderDraftDate = useMemo(() => {
    const nextDate = new Date();
    nextDate.setHours(
      defaultReminderDraftHour,
      alignMinuteToClockInterval(defaultReminderDraftMinute, defaultReminderDraftClockInterval),
      0,
      0,
    );
    return nextDate;
  }, [defaultReminderDraftHour, defaultReminderDraftMinute, defaultReminderDraftClockInterval]);

  const handleSelectClockInterval = async (interval: 1 | 5 | 15) => {
    if (isSavingDefaultReminderTime || interval === defaultReminderClockInterval) {
      return;
    }

    const normalizedMinute = alignMinuteToClockInterval(defaultReminderMinute, interval);
    setIsSavingDefaultReminderTime(true);

    try {
      await saveReminderDefaultTimeSettings({
        hour: defaultReminderHour,
        minute: normalizedMinute,
        clockIntervalMinutes: interval,
      }, user.id);

      setDefaultReminderMinute(normalizedMinute);
      setDefaultReminderDraftMinute(normalizedMinute);
      setDefaultReminderClockInterval(interval);
      setDefaultReminderDraftClockInterval(interval);
      setMessage('Clock interval updated.');
    } catch (error) {
      console.warn('Unable to save account clock interval settings', error);
      setMessage('Unable to update clock interval right now.');
    } finally {
      setIsSavingDefaultReminderTime(false);
    }
  };

  const handleSaveReminderTimeZone = async () => {
    setIsSavingReminderTimeZone(true);

    try {
      await saveReminderTimeZoneSettings({
        timeZone: defaultReminderTimeZoneDraft,
      }, user.id);
      setDefaultReminderTimeZone(defaultReminderTimeZoneDraft);
      onReminderTimeZoneUpdated(defaultReminderTimeZoneDraft);
      setShowReminderTimeZoneEditor(false);
      setMessage('Default reminder time zone updated.');
    } catch (error) {
      console.warn('Unable to save account default reminder time zone settings', error);
      setMessage('Unable to update default reminder time zone right now.');
    } finally {
      setIsSavingReminderTimeZone(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!deliveryDevice && !deliveryEmail && !deliveryText) {
      setMessage('Please choose a delivery type before saving your details.');
      return;
    }

    const previousMobileDigits = String(user.mobileNumber || '').replace(/\D/g, '').slice(0, 10);
    const nextMobileDigits = String(mobileNumber || '').replace(/\D/g, '').slice(0, 10);
    const mobileChanged = previousMobileDigits !== nextMobileDigits;

    const birthDateError = validateBirthDate(birthDate);
    if (birthDateError) {
      setMessage(birthDateError);
      return;
    }

    if (mobileNumber.trim()) {
      const phoneError = validatePhoneNumber(mobileNumber);
      if (phoneError) {
        setMessage(phoneError);
        return;
      }
    }

    if (!firstName.trim()) {
      setMessage('Please enter your first name.');
      return;
    }

    if (!lastName.trim()) {
      setMessage('Please enter your last name.');
      return;
    }

    try {
      setIsSaving(true);
      const result = await updateUserProfile(user.id, {
        mobileNumber: mobileNumber.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`.trim(),
        birthDate: birthDate.trim(),
      });
      setIsSaving(false);

      if (result.error) {
        setMessage(result.error);
        return;
      }

      onUserUpdated(result.user!);
      setIsMobileNumberVerified(Boolean(result.user?.mobileNumberVerified));

      if (mobileChanged && deliveryText) {
        try {
          await saveReminderDeliverySettings({
            device: deliveryDevice,
            email: deliveryEmail,
            text: false,
          }, user.id);
          setDeliveryText(false);
          setIsMobileNumberVerified(false);
          await startMobileVerificationFlow();
        } catch (error) {
          console.warn('Unable to reset text reminders after mobile update', error);
          setMessage('Mobile phone changed. Text reminders were turned off until verification completes.');
        }
        return;
      }

      setMessage('Profile updated successfully.');
    } catch (error) {
      setIsSaving(false);
      setMessage('Unable to save profile right now.');
    }
  };

  const handleBack = () => {
    if (!deliveryDevice && !deliveryEmail && !deliveryText) {
      setMessage('Please choose a delivery type before leaving this page.');
      return;
    }

    onBack();
  };

  const closeContactSupportModal = () => {
    setShowContactSupportModal(false);
    setContactSupportSubject('');
    setContactSupportMessage('');
    setContactSupportError(null);
  };

  const handleSendContactSupportMessage = async () => {
    const normalizedSubject = contactSupportSubject.trim();
    const normalizedMessage = contactSupportMessage.trim();

    if (!normalizedSubject) {
      setContactSupportError('Subject is required.');
      return;
    }

    if (!normalizedMessage) {
      setContactSupportError('Enter a message for Contact Us.');
      return;
    }

    if (normalizedMessage.length > 255) {
      setContactSupportError('Contact Us message can be up to 255 characters.');
      return;
    }

    setContactSupportError(null);
    setIsSendingContactSupport(true);
    const result = await sendContactSupportMessage({
      userId: user.id,
      userEmail: user.email,
      subject: normalizedSubject,
      message: normalizedMessage,
    });
    setIsSendingContactSupport(false);

    if (!result.success) {
      setContactSupportError(result.error || 'Unable to send Contact Us message right now.');
      return;
    }

    closeContactSupportModal();
    setMessage('Your message was sent to support.');
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage('Please fill in the current password, new password, and confirmation.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setMessage('The new passwords do not match.');
      return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setMessage(passwordError);
      return;
    }

    try {
      setIsSaving(true);
      const result = await changePassword(user.id, currentPassword, newPassword);
      setIsSaving(false);

      if (result.error) {
        setMessage(result.error);
        return;
      }

      onUserUpdated(result.user!);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
      setShowPasswordModal(false);
      setMessage('Password updated successfully.');
    } catch (error) {
      setIsSaving(false);
      setMessage('Unable to change password right now.');
    }
  };

  const handleDelete = async () => {
    setShowDeleteConfirm(true);
  };

  const normalizeContactsSnapshot = (raw: string | null): ContactsSnapshot => {
    if (!raw) {
      return { contacts: [], groups: [] };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<ContactsSnapshot> | AccountContact[];
      const parsedContacts = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Partial<ContactsSnapshot>).contacts)
          ? (parsed as Partial<ContactsSnapshot>).contacts as AccountContact[]
          : [];
      const parsedGroups = !Array.isArray(parsed) && Array.isArray((parsed as Partial<ContactsSnapshot>).groups)
        ? (parsed as Partial<ContactsSnapshot>).groups as ContactGroup[]
        : [];

      const contacts = parsedContacts
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }

          const candidate = entry as Partial<AccountContact>;
          const id = String(candidate.id || '').trim();
          const email = String(candidate.email || '').trim().toLowerCase();
          const mobileNumber = candidate.mobileNumber ? String(candidate.mobileNumber).trim() : '';
          const company = candidate.company ? String(candidate.company).trim() : '';
          const fallbackName = splitNameParts(String((candidate as { fullName?: string }).fullName || ''));
          const firstName = String(candidate.firstName || fallbackName.firstName).trim();
          const lastName = String(candidate.lastName || fallbackName.lastName).trim();

          if (!id || (!email && !mobileNumber) || (!firstName && !lastName && !company)) {
            return null;
          }

          const deletedAtRaw = candidate.deletedAt ? String(candidate.deletedAt) : null;

          return {
            id,
            email,
            firstName,
            lastName,
            address: candidate.address ? String(candidate.address).trim() : '',
            birthDate: candidate.birthDate ? String(candidate.birthDate).trim() : '',
            mobileNumber,
            company,
            notes: candidate.notes ? String(candidate.notes).trim() : '',
            isFavorite: candidate.isFavorite === true,
            groupIds: Array.isArray(candidate.groupIds) ? candidate.groupIds.map((groupId) => String(groupId || '').trim()).filter(Boolean) : [],
            createdAt: candidate.createdAt ? String(candidate.createdAt) : new Date().toISOString(),
            updatedAt: candidate.updatedAt ? String(candidate.updatedAt) : new Date().toISOString(),
            deletedAt: deletedAtRaw,
          } as AccountContact;
        })
        .filter((entry): entry is AccountContact => entry !== null);

      const groups = parsedGroups
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }

          const candidate = entry as Partial<ContactGroup>;
          const id = String(candidate.id || '').trim();
          const name = String(candidate.name || '').trim();
          if (!id || !name) {
            return null;
          }

          return {
            id,
            name,
            description: candidate.description ? String(candidate.description).trim() : '',
            contactIds: Array.isArray(candidate.contactIds) ? candidate.contactIds.map((contactId) => String(contactId || '').trim()).filter(Boolean) : [],
            createdAt: candidate.createdAt ? String(candidate.createdAt) : new Date().toISOString(),
          } as ContactGroup;
        })
        .filter((entry): entry is ContactGroup => entry !== null);

      return { contacts, groups };
    } catch (error) {
      console.warn('Unable to parse contacts snapshot', error);
      return { contacts: [], groups: [] };
    }
  };

  const persistContactsSnapshot = useCallback(async (nextContacts: AccountContact[], nextGroups: ContactGroup[]) => {
    const payload: ContactsSnapshot = {
      contacts: nextContacts,
      groups: nextGroups,
      ownerUserId: user.id,
      ownerEmail: String(user.email || '').trim().toLowerCase(),
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
    };

    await AsyncStorage.setItem(getContactsStorageKey(user.id), JSON.stringify(payload));

    if (isApiStorageEnabled()) {
      const saveResult = await saveUserContactsSnapshot(user.id, payload);
      if (!saveResult.success) {
        console.warn('Unable to save contacts snapshot to backend', saveResult.error);
      } else {
        setContactsLastSyncedAt(payload.updatedAt || new Date().toISOString());
      }
    } else {
      setContactsLastSyncedAt(payload.updatedAt || new Date().toISOString());
    }

    setContacts(nextContacts);
    setContactGroups(nextGroups);
  }, [user.email, user.id]);

  const loadContacts = useCallback(async () => {
    setIsLoadingContacts(true);
    try {
      const primaryKey = getContactsStorageKey(user.id);
      const rawContacts = await AsyncStorage.getItem(primaryKey);
      let snapshot = normalizeContactsSnapshot(rawContacts);

      if (isApiStorageEnabled()) {
        const remoteSnapshotResult = await loadUserContactsSnapshot(user.id);
        setContactsLastSyncedAt(remoteSnapshotResult?.updatedAt || null);
        if (remoteSnapshotResult?.snapshot && typeof remoteSnapshotResult.snapshot === 'object') {
          const remoteSnapshot = normalizeContactsSnapshot(JSON.stringify(remoteSnapshotResult.snapshot));
          const localScore = (snapshot.contacts.length * 10) + snapshot.groups.length;
          const remoteScore = (remoteSnapshot.contacts.length * 10) + remoteSnapshot.groups.length;

          if (remoteScore > localScore) {
            snapshot = remoteSnapshot;

            const migratedPayload: ContactsSnapshot = {
              contacts: snapshot.contacts,
              groups: snapshot.groups,
              ownerUserId: user.id,
              ownerEmail: String(user.email || '').trim().toLowerCase(),
              schemaVersion: 2,
              updatedAt: new Date().toISOString(),
            };
            await AsyncStorage.setItem(primaryKey, JSON.stringify(migratedPayload));
          }
        }
      }

      if (!isApiStorageEnabled()) {
        setContactsLastSyncedAt(snapshot.updatedAt || null);
      }

      if (!snapshot.contacts.length && !snapshot.groups.length) {
        const allKeys = await AsyncStorage.getAllKeys();
        const legacyKeys = allKeys.filter((key) => key.startsWith(CONTACTS_STORAGE_KEY_PREFIX) && key !== primaryKey);

        if (legacyKeys.length) {
          const normalizedEmail = String(user.email || '').trim().toLowerCase();
          const prioritizedKeys = [
            ...legacyKeys.filter((key) => normalizedEmail && key.toLowerCase().includes(normalizedEmail)),
            ...legacyKeys.filter((key) => !normalizedEmail || !key.toLowerCase().includes(normalizedEmail)),
          ];

          const legacyEntries = await AsyncStorage.multiGet(prioritizedKeys);
          let bestSnapshot: ContactsSnapshot | null = null;
          let bestScore = 0;

          legacyEntries.forEach(([, raw]) => {
            const candidate: ContactsSnapshot = normalizeContactsSnapshot(raw);
            const score = (candidate.contacts.length * 10) + candidate.groups.length;
            if (score > bestScore) {
              bestScore = score;
              bestSnapshot = candidate;
            }
          });

          const legacySnapshot = bestSnapshot as ContactsSnapshot | null;
          if (legacySnapshot) {
            const { contacts, groups } = legacySnapshot;
            if (contacts.length || groups.length) {
              snapshot = legacySnapshot;
              const migratedPayload: ContactsSnapshot = {
                contacts: snapshot.contacts,
                groups: snapshot.groups,
                ownerUserId: user.id,
                ownerEmail: normalizedEmail,
                schemaVersion: 2,
                updatedAt: new Date().toISOString(),
              };
              await AsyncStorage.setItem(primaryKey, JSON.stringify(migratedPayload));
            }
          }
        }
      }

      setContacts(snapshot.contacts);
      setContactGroups(snapshot.groups);

      setSelectedGroupId((current) => {
        if (current && snapshot.groups.some((group) => group.id === current)) {
          return current;
        }

        return snapshot.groups[0]?.id || '';
      });
    } catch (error) {
      console.warn('Unable to load account contacts', error);
      setContacts([]);
      setContactGroups([]);
      setSelectedGroupId('');
    } finally {
      setIsLoadingContacts(false);
    }
  }, [user.email, user.id]);

  const resetContactEditor = () => {
    setContactDraft(createEmptyContactDraft());
    setContactAddressLine1('');
    setContactAddressLine2('');
    setContactAddressCity('');
    setContactAddressState('');
    setContactAddressZip('');
    setContactAddressPredictions([]);
    setEditingContactId(null);
    setIsEditingContact(false);
  };

  const openNewContactEditor = () => {
    setContactsMessage(null);
    setContactDraft(createEmptyContactDraft());
    setContactAddressLine1('');
    setContactAddressLine2('');
    setContactAddressCity('');
    setContactAddressState('');
    setContactAddressZip('');
    setContactAddressPredictions([]);
    setEditingContactId(null);
    setActiveSummaryContactId(null);
    setIsEditingContact(true);
  };

  const mapDeviceContactToImportCandidate = useCallback((entry: {
    id?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    emails?: Array<{ email?: string }>;
    phoneNumbers?: Array<{ number?: string }>;
    company?: string;
    birthday?: { month?: number | null; day?: number | null; year?: number | null } | null;
  }): DeviceContactImportCandidate | null => {
    const rawName = String(entry.name || '').trim();
    const derivedNameParts = splitNameParts(rawName);
    const company = String(entry.company || '').trim();
    const firstName = String(entry.firstName || '').trim() || derivedNameParts.firstName || company;
    const lastName = String(entry.lastName || '').trim() || derivedNameParts.lastName;
    const email = String(entry.emails?.[0]?.email || '').trim().toLowerCase();
    const mobileNumber = formatPhoneNumberInput(String(entry.phoneNumbers?.[0]?.number || '').trim());
    const birthDate = formatImportedBirthDate(entry.birthday);

    if (!Boolean(firstName || lastName || company) || !Boolean(email || mobileNumber)) {
      return null;
    }

    return {
      id: String(entry.id || generateUUID()),
      firstName,
      lastName,
      email,
      mobileNumber,
      company,
      birthDate,
    };
  }, []);

  const importDeviceContacts = useCallback(async (selectedContacts: DeviceContactImportCandidate[]) => {
    if (!selectedContacts.length) {
      setContactsMessage('No eligible iPhone contacts were selected for import.');
      return;
    }

    const seenEmails = new Set(activeContactEmails);
    const seenPhones = new Set(activeContactPhones);
    const filteredContacts: DeviceContactImportCandidate[] = [];

    selectedContacts.forEach((entry) => {
      const emailKey = String(entry.email || '').trim().toLowerCase();
      const phoneKey = normalizePhoneDigits(String(entry.mobileNumber || ''));
      const isDuplicate = (emailKey && seenEmails.has(emailKey)) || (phoneKey && seenPhones.has(phoneKey));

      if (isDuplicate) {
        return;
      }

      filteredContacts.push(entry);
      if (emailKey) {
        seenEmails.add(emailKey);
      }
      if (phoneKey) {
        seenPhones.add(phoneKey);
      }
    });

    if (!filteredContacts.length) {
      setContactsMessage(selectedContacts.length === 1 ? 'That contact is already in your saved contacts.' : 'All eligible iPhone contacts are already added.');
      return;
    }

    const timestamp = new Date().toISOString();
    const nextContacts = [...contacts];

    filteredContacts.forEach((entry) => {
      nextContacts.push({
        id: generateUUID(),
        email: entry.email,
        firstName: entry.firstName,
        lastName: entry.lastName,
        address: '',
        birthDate: entry.birthDate,
        mobileNumber: entry.mobileNumber,
        company: entry.company,
        notes: 'Imported from iPhone contacts.',
        isFavorite: false,
        groupIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
    });

    await persistContactsSnapshot(nextContacts, contactGroups);
    const duplicateCount = selectedContacts.length - filteredContacts.length;
    if (duplicateCount > 0) {
      setContactsMessage(filteredContacts.length === 1
        ? `Imported ${getContactDisplayName(filteredContacts[0])}. Skipped ${duplicateCount} duplicate contact${duplicateCount === 1 ? '' : 's'}.`
        : `Imported ${filteredContacts.length} iPhone contacts. Skipped ${duplicateCount} duplicate contact${duplicateCount === 1 ? '' : 's'}.`);
      return;
    }

    setContactsMessage(filteredContacts.length === 1
      ? `Imported ${getContactDisplayName(filteredContacts[0])}.`
      : `Imported ${filteredContacts.length} iPhone contacts.`);
  }, [activeContactEmails, activeContactPhones, contactGroups, contacts, persistContactsSnapshot]);

  const loadDeviceContactsForImport = useCallback(async () => {
    if (Platform.OS === 'web') {
      setContactsMessage('Device contacts import is not supported in the web build. Use an iPhone or iPad app build.');
      return;
    }

    setContactsMessage(null);
    setShowDeviceContactsImportModal(false);
    setIsLoadingDeviceContacts(true);
    try {
      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        setContactsMessage('Allow Contacts access on your iPhone to import contacts.');
        return;
      }

      const selectedContact = await Contacts.presentContactPickerAsync();
      if (!selectedContact) {
        return;
      }

      const fullContact = selectedContact.id
        ? await Contacts.getContactByIdAsync(String(selectedContact.id), [
            Contacts.Fields.Name,
            Contacts.Fields.FirstName,
            Contacts.Fields.LastName,
            Contacts.Fields.Emails,
            Contacts.Fields.PhoneNumbers,
            Contacts.Fields.Company,
            Contacts.Fields.Birthday,
          ])
        : selectedContact;

      const candidate = mapDeviceContactToImportCandidate(fullContact || selectedContact);
      if (!candidate) {
        setContactsMessage('That iPhone contact does not have an importable email or mobile phone number.');
        return;
      }

      await importDeviceContacts([candidate]);
    } catch (error) {
      console.warn('Unable to load device contacts for import', error);
      setContactsMessage('Unable to load iPhone contacts right now.');
    } finally {
      setIsLoadingDeviceContacts(false);
    }
  }, [importDeviceContacts, mapDeviceContactToImportCandidate]);

  const openEditContactEditor = (contact: AccountContact) => {
    const addressParts = parseAddressParts(contact.address || '');
    setContactsMessage(null);
    setContactDraft({
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      address: contact.address,
      birthDate: contact.birthDate,
      mobileNumber: formatPhoneNumberInput(contact.mobileNumber || ''),
      company: contact.company,
      notes: contact.notes,
    });
    setContactAddressLine1(addressParts.line1);
    setContactAddressLine2(addressParts.line2);
    setContactAddressCity(addressParts.city);
    setContactAddressState(addressParts.state);
    setContactAddressZip(addressParts.zip);
    setContactAddressPredictions([]);
    setActiveSummaryContactId(null);
    setEditingContactId(contact.id);
    setIsEditingContact(true);
  };

  const handleContactEmailBlur = async () => {
    const normalizedEmail = contactDraft.email.trim().toLowerCase();
    if (!normalizedEmail || !validateEmail(normalizedEmail)) {
      return;
    }

    try {
      const matchedUser = await findUserByEmail(normalizedEmail);
      if (!matchedUser) {
        return;
      }

      const hasAddressDraft = Boolean(composeAddressParts({
        line1: contactAddressLine1,
        line2: contactAddressLine2,
        city: contactAddressCity,
        state: contactAddressState,
        zip: contactAddressZip,
      }).trim());

      if (!hasAddressDraft) {
        const matchedAddressParts = parseAddressParts(String(matchedUser.address || ''));
        setContactAddressLine1(matchedAddressParts.line1);
        setContactAddressLine2(matchedAddressParts.line2);
        setContactAddressCity(matchedAddressParts.city);
        setContactAddressState(matchedAddressParts.state);
        setContactAddressZip(matchedAddressParts.zip);
      }

      setContactDraft((current) => ({
        ...current,
        email: normalizedEmail,
        firstName: current.firstName.trim() || splitNameParts(String(matchedUser.fullName || '')).firstName,
        lastName: current.lastName.trim() || splitNameParts(String(matchedUser.fullName || '')).lastName,
        address: current.address.trim() || String(matchedUser.address || '').trim(),
        birthDate: current.birthDate.trim() || String(matchedUser.birthDate || '').trim(),
        mobileNumber: current.mobileNumber.trim() || formatPhoneNumberInput(String(matchedUser.mobileNumber || '').trim()),
      }));
      setContactsMessage('Matching registered user found. Contact fields were auto-filled where available.');
    } catch {
      // Ignore autofill lookup failures and allow manual entry.
    }
  };

  const saveContact = async () => {
    const normalizedEmail = contactDraft.email.trim().toLowerCase();
    const normalizedFirstName = contactDraft.firstName.trim();
    const normalizedLastName = contactDraft.lastName.trim();
    const normalizedAddress = composeAddressParts({
      line1: contactAddressLine1,
      line2: contactAddressLine2,
      city: contactAddressCity,
      state: contactAddressState,
      zip: contactAddressZip,
    }).trim();
    const normalizedBirthDate = contactDraft.birthDate.trim();
    const normalizedMobile = contactDraft.mobileNumber.trim();
    const normalizedMobileDigits = normalizePhoneDigits(normalizedMobile);
    const normalizedCompany = contactDraft.company.trim();
    const normalizedNotes = contactDraft.notes.trim();

    if (!normalizedEmail && !normalizedMobile) {
      setContactsMessage('Enter at least an email address or mobile phone number.');
      return;
    }

    if (normalizedEmail && !validateEmail(normalizedEmail)) {
      setContactsMessage('Enter a valid contact email address.');
      return;
    }

    if (!normalizedFirstName && !normalizedLastName) {
      setContactsMessage('Enter at least a first name or last name.');
      return;
    }

    if (normalizedBirthDate) {
      const birthDateError = validateBirthDate(normalizedBirthDate);
      if (birthDateError) {
        setContactsMessage(birthDateError);
        return;
      }
    }

    if (normalizedMobile) {
      const phoneError = validatePhoneNumber(normalizedMobile);
      if (phoneError) {
        setContactsMessage(phoneError);
        return;
      }
    }

    const duplicate = contacts.find((entry) => (
      entry.id !== editingContactId
      && (
        (normalizedEmail && entry.email.trim().toLowerCase() === normalizedEmail)
        || (normalizedMobileDigits && normalizePhoneDigits(entry.mobileNumber || '') === normalizedMobileDigits)
      )
    ));

    if (duplicate) {
      setContactsMessage('A contact with this email or mobile phone already exists.');
      return;
    }

    const now = new Date().toISOString();
    const nextContacts = editingContactId
      ? contacts.map((entry) => (
          entry.id === editingContactId
            ? {
                ...entry,
                email: normalizedEmail,
                firstName: normalizedFirstName,
                lastName: normalizedLastName,
                address: normalizedAddress,
                birthDate: normalizedBirthDate,
                mobileNumber: normalizedMobile,
                company: normalizedCompany,
                notes: normalizedNotes,
                updatedAt: now,
              }
            : entry
        ))
      : [
          ...contacts,
          {
            id: generateUUID(),
            email: normalizedEmail,
            firstName: normalizedFirstName,
            lastName: normalizedLastName,
            address: normalizedAddress,
            birthDate: normalizedBirthDate,
            mobileNumber: normalizedMobile,
            company: normalizedCompany,
            notes: normalizedNotes,
            isFavorite: false,
            groupIds: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ];

    await persistContactsSnapshot(nextContacts, contactGroups);
    resetContactEditor();
    setContactsMessage(editingContactId ? 'Contact updated.' : 'Contact added.');
  };

  const toggleFavoriteContact = async (contactId: string) => {
    const nextContacts = contacts.map((entry) => (
      entry.id === contactId
        ? {
            ...entry,
            isFavorite: !entry.isFavorite,
            updatedAt: new Date().toISOString(),
          }
        : entry
    ));
    await persistContactsSnapshot(nextContacts, contactGroups);
  };

  const permanentlyDeleteContact = async (contactId: string) => {
    const nextContacts = contacts.filter((entry) => entry.id !== contactId);
    const nextGroups = contactGroups.map((group) => ({
      ...group,
      contactIds: group.contactIds.filter((id) => id !== contactId),
    }));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setContactsMessage('Contact deleted.');
  };

  const createContactGroup = async () => {
    const normalizedName = newGroupName.trim();
    const normalizedDescription = newGroupDescription.trim();
    if (!normalizedName) {
      setContactsMessage('Enter a group name.');
      return;
    }

    if (contactGroups.some((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase())) {
      setContactsMessage('A group with this name already exists.');
      return;
    }

    const nextGroup: ContactGroup = {
      id: generateUUID(),
      name: normalizedName,
      description: normalizedDescription,
      contactIds: [],
      createdAt: new Date().toISOString(),
    };

    const nextGroups = [...contactGroups, nextGroup];
    await persistContactsSnapshot(contacts, nextGroups);
    setSelectedGroupId(nextGroup.id);
    setNewGroupName('');
    setNewGroupDescription('');
    setShowCreateGroupModal(false);
    setGroupsDisplayMode('manage');
    setContactsMessage('Group created.');
  };

  const getNextGroupCloneName = useCallback((baseName: string) => {
    const trimmedBase = baseName.trim();
    if (!trimmedBase) {
      return 'Group1';
    }

    let suffix = 1;
    let candidate = `${trimmedBase}${suffix}`;
    while (contactGroups.some((entry) => entry.name.toLowerCase() === candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${trimmedBase}${suffix}`;
    }
    return candidate;
  }, [contactGroups]);

  const cloneContactGroup = async (sourceGroupId: string) => {
    const sourceGroup = contactGroups.find((entry) => entry.id === sourceGroupId);
    if (!sourceGroup) {
      setContactsMessage('Select a group to clone.');
      return;
    }

    const nextGroupName = getNextGroupCloneName(sourceGroup.name);
    const nextGroup: ContactGroup = {
      id: generateUUID(),
      name: nextGroupName,
      description: sourceGroup.description,
      contactIds: [...sourceGroup.contactIds],
      createdAt: new Date().toISOString(),
    };

    const nextGroups = [...contactGroups, nextGroup];
    const nextContacts = contacts.map((entry) => {
      const isInClonedGroup = sourceGroup.contactIds.includes(entry.id);
      if (!isInClonedGroup) {
        return entry;
      }

      return {
        ...entry,
        groupIds: entry.groupIds.includes(nextGroup.id) ? entry.groupIds : [...entry.groupIds, nextGroup.id],
        updatedAt: new Date().toISOString(),
      };
    });

    await persistContactsSnapshot(nextContacts, nextGroups);
    setSelectedGroupId(nextGroup.id);
    setSelectedGroupNameDraft(nextGroupName);
    setGroupsDisplayMode('manage');
    setShowCloneGroupModal(false);
    setContactsMessage(`Group cloned as ${nextGroupName}.`);
  };

  const saveSelectedGroupName = async () => {
    if (!selectedGroup) {
      return;
    }

    const normalizedName = selectedGroupNameDraft.trim();
    if (!normalizedName) {
      setContactsMessage('Enter a group name.');
      return;
    }

    if (contactGroups.some((entry) => entry.id !== selectedGroup.id && entry.name.toLowerCase() === normalizedName.toLowerCase())) {
      setContactsMessage('A group with this name already exists.');
      return;
    }

    const nextGroups = contactGroups.map((group) => (
      group.id === selectedGroup.id
        ? {
            ...group,
            name: normalizedName,
          }
        : group
    ));

    await persistContactsSnapshot(contacts, nextGroups);
    setGroupNameSaveState('saved');
    setTimeout(() => setGroupNameSaveState('idle'), 500);
    setContactsMessage('Group name updated.');
  };

  const addSelectedContactToSelectedGroup = async (contactIdOverride?: string) => {
    if (!selectedGroup) {
      setContactsMessage('Select a group and contact first.');
      return;
    }

    const contactIdToAdd = contactIdOverride || selectedContactIdToAdd || contactsAvailableForSelectedGroup[0]?.id || '';
    if (!contactIdToAdd) {
      setContactsMessage('No contacts are available to add.');
      return;
    }

    const nextGroups = contactGroups.map((group) => (
      group.id === selectedGroup.id
        ? {
            ...group,
            contactIds: group.contactIds.includes(contactIdToAdd)
              ? group.contactIds
              : [...group.contactIds, contactIdToAdd],
          }
        : group
    ));

    const nextContacts = contacts.map((entry) => (
      entry.id === contactIdToAdd
        ? {
            ...entry,
            groupIds: entry.groupIds.includes(selectedGroup.id)
              ? entry.groupIds
              : [...entry.groupIds, selectedGroup.id],
            updatedAt: new Date().toISOString(),
          }
        : entry
    ));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setSelectedContactIdToAdd('');
    setContactsMessage('Contact added to group.');
  };

  const removeContactFromSelectedGroup = async (contactId: string) => {
    if (!selectedGroup) {
      return;
    }

    const nextGroups = contactGroups.map((group) => (
      group.id === selectedGroup.id
        ? {
            ...group,
            contactIds: group.contactIds.filter((entry) => entry !== contactId),
          }
        : group
    ));

    const nextContacts = contacts.map((entry) => (
      entry.id === contactId
        ? {
            ...entry,
            groupIds: entry.groupIds.filter((groupId) => groupId !== selectedGroup.id),
            updatedAt: new Date().toISOString(),
          }
        : entry
    ));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setContactsMessage('Contact removed from group.');
  };

  const saveSelectedGroupDescription = async () => {
    if (!selectedGroup) {
      return;
    }

    const normalizedDescription = selectedGroupDescriptionDraft.trim();
    const nextGroups = contactGroups.map((group) => (
      group.id === selectedGroup.id
        ? {
            ...group,
            description: normalizedDescription,
          }
        : group
    ));

    await persistContactsSnapshot(contacts, nextGroups);
    setGroupDescriptionSaveState('saved');
    setTimeout(() => setGroupDescriptionSaveState('idle'), 500);
    setContactsMessage('Group description updated.');
  };

  const deleteSelectedGroup = async (groupId: string) => {
    const groupToDelete = contactGroups.find((entry) => entry.id === groupId);
    if (!groupToDelete) {
      setGroupDeleteCandidateId(null);
      return;
    }

    const nextGroups = contactGroups.filter((group) => group.id !== groupId);
    const nextContacts = contacts.map((entry) => ({
      ...entry,
      groupIds: entry.groupIds.filter((entryGroupId) => entryGroupId !== groupId),
      updatedAt: new Date().toISOString(),
    }));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setGroupDeleteCandidateId(null);
    if (selectedGroupId === groupId) {
      setSelectedGroupId('');
      setGroupsDisplayMode('summary');
    }
    setContactsMessage(`Group "${groupToDelete.name}" deleted.`);
  };

  const handleOpenContacts = async () => {
    await loadContacts();
    setActiveContactsView('none');
    setGroupsDisplayMode('summary');
    setNewGroupName('');
    setNewGroupDescription('');
    setSelectedGroupId('');
    setContactsMessage(null);
    resetContactEditor();
    setShowContactsModal(true);
  };

  const closeContactsPanel = () => {
    setShowCreateGroupModal(false);
    setShowContactsModal(false);
  };

  const handleContactsBack = () => {
    if (isEditingContact) {
      resetContactEditor();
      return;
    }

    if (activeContactsView !== 'none') {
      setContactsMessage(null);
      setActiveSummaryContactId(null);
      setGroupsDisplayMode('summary');
      setSelectedGroupId('');
      setActiveContactsView('none');
      return;
    }

    if (returnToLanding) {
      closeContactsPanel();
      onBackToLanding?.();
      return;
    }

    closeContactsPanel();
  };

  const handleConfirmDelete = async () => {

    try {
      setIsSaving(true);
      const result = await deleteUser(user.id);
      setIsSaving(false);

      if (!result.success) {
        setMessage('Unable to delete account right now.');
        setShowDeleteConfirm(false);
        return;
      }

      onDeleteAccount();
    } catch (error) {
      setIsSaving(false);
      setShowDeleteConfirm(false);
      setMessage('Unable to delete account right now.');
    }
  };

  const handleSettingsBack = () => {
    if (activeAccountAction === 'calendar-sync' || showCalendarSyncEditor) {
      setMessage(null);
      setShowCalendarSyncEditor(false);
      setActiveAccountAction('none');
      if (returnToLanding) {
        onBackToLanding?.();
      }
      return;
    }

    if (activeAccountAction !== 'none') {
      setMessage(null);
      setActiveAccountAction('none');
      return;
    }

    handleBack();
  };

  useEffect(() => {
    if (!initialAccountAction) {
      return;
    }

    if (initialAccountAction === 'contacts') {
      void handleOpenContacts();
    }

    if (initialAccountAction === 'calendar-sync') {
      setActiveAccountAction('calendar-sync');
    }

    onInitialActionHandled?.();
  }, [initialAccountAction, onInitialActionHandled]);

  return (
    <ScrollView style={styles.accountScreen} contentContainerStyle={styles.accountScreenContent} keyboardShouldPersistTaps="handled">
      {showPasswordModal ? (
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Change password</Text>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            <View style={styles.passwordInputWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Current password"
                value={currentPassword}
                onChangeText={(value) => {
                  setCurrentPassword(value);
                  if (message) {
                    setMessage(null);
                  }
                }}
                secureTextEntry={!showCurrentPassword}
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowCurrentPassword((value) => !value)} activeOpacity={0.8}>
                <Text style={styles.passwordToggleText}>{showCurrentPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.passwordInputWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="New password"
                value={newPassword}
                onChangeText={(value) => {
                  setNewPassword(value);
                  if (message) {
                    setMessage(null);
                  }
                }}
                secureTextEntry={!showNewPassword}
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowNewPassword((value) => !value)} activeOpacity={0.8}>
                <Text style={styles.passwordToggleText}>{showNewPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.passwordInputWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Confirm new password"
                value={confirmPassword}
                onChangeText={(value) => {
                  setConfirmPassword(value);
                  if (message) {
                    setMessage(null);
                  }
                }}
                secureTextEntry={!showConfirmPassword}
              />
              <TouchableOpacity style={styles.passwordToggle} onPress={() => setShowConfirmPassword((value) => !value)} activeOpacity={0.8}>
                <Text style={styles.passwordToggleText}>{showConfirmPassword ? '🙈' : '👁️'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.modalActionsRow}>
              <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={handleChangePassword} disabled={isSaving}>
                <Text style={styles.primaryButtonText}>{isSaving ? 'Updating…' : 'Change password'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setShowCurrentPassword(false);
                  setShowNewPassword(false);
                  setShowConfirmPassword(false);
                  setShowPasswordModal(false);
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      <TimePickerModal
        visible={showDefaultReminderTimeEditor}
        title="Reminder time"
        initialDate={defaultReminderDraftDate}
        minuteInterval={defaultReminderDraftClockInterval}
        saveLabel={isSavingDefaultReminderTime ? 'Saving…' : 'Save'}
        onCancel={() => {
          setDefaultReminderDraftHour(defaultReminderHour);
          setDefaultReminderDraftMinute(defaultReminderMinute);
          setDefaultReminderDraftClockInterval(defaultReminderClockInterval);
          setShowDefaultReminderTimeEditor(false);
        }}
        onSave={(selectedDate) => {
          if (isSavingDefaultReminderTime) {
            return;
          }

          const selectedHour = selectedDate.getHours();
          const selectedMinute = alignMinuteToClockInterval(selectedDate.getMinutes(), defaultReminderDraftClockInterval);
          setDefaultReminderDraftHour(selectedHour);
          setDefaultReminderDraftMinute(selectedMinute);
          void handleSaveDefaultReminderTime({ hour: selectedHour, minute: selectedMinute });
        }}
      />

      <Modal
        transparent
        visible={showReminderTimeZoneEditor}
        animationType="slide"
        onRequestClose={() => {
          setDefaultReminderTimeZoneDraft(defaultReminderTimeZone);
          setShowReminderTimeZoneEditor(false);
        }}
      >
        <View style={[styles.modalOverlay, styles.timeZoneModalOverlay]}>
          <View style={[styles.modalCard, styles.timeZoneModalCard]}>
            <View style={styles.timeZoneSheetHandle} />
            <Text style={styles.modalTitle}>Reminder time zone</Text>
            <View style={[styles.pickerWrapper, styles.timeZonePickerWrapper]}>
              <Picker
                selectedValue={defaultReminderTimeZoneDraft}
                onValueChange={(value) => setDefaultReminderTimeZoneDraft(String(value || getDeviceTimeZone()))}
                style={[styles.picker, styles.timeZonePicker]}
              >
                {TIME_ZONE_OPTIONS.map((timeZone) => (
                  <Picker.Item key={timeZone} label={timeZone} value={timeZone} />
                ))}
              </Picker>
            </View>

            <View style={[styles.modalActionsRow, styles.timeZoneModalActionsRow]}>
              <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={() => void handleSaveReminderTimeZone()} disabled={isSavingReminderTimeZone}>
                <Text style={[styles.primaryButtonText, styles.timeZoneModalActionText]}>{isSavingReminderTimeZone ? 'Saving…' : 'Save Zone'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setDefaultReminderTimeZoneDraft(defaultReminderTimeZone);
                  setShowReminderTimeZoneEditor(false);
                }}
              >
                <Text style={[styles.secondaryButtonText, styles.timeZoneModalActionText]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        visible={showDeviceNotificationInstructions}
        animationType="fade"
        onRequestClose={() => setShowDeviceNotificationInstructions(false)}
      >
        <View style={[styles.modalOverlay, styles.fullScreenModalOverlay]}>
          <View style={[styles.modalCard, styles.fullScreenModalCard]}>
            <Text style={styles.modalTitle}>Device Notification Instructions</Text>
            <Text style={styles.deleteHint}>On your device go to Settings → Notifications → Remind Me This.</Text>
            <Text style={styles.deleteHint}>Allow Notifications = ON</Text>
            <Text style={styles.deleteHint}>Lock Screen, Notification Center, Banners = ON</Text>
            <Text style={styles.deleteHint}>Sounds = ON</Text>

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => setShowDeviceNotificationInstructions(false)}
              >
                <Text style={styles.secondaryButtonText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {showCalendarSyncEditor ? (
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {calendarSyncProviderDraft === 'google'
                ? 'Google Calendar sync'
                : calendarSyncProviderDraft === 'outlook'
                  ? 'Outlook Calendar sync'
                  : 'Apple Calendar sync'}
            </Text>

            {calendarSyncProviderDraft === 'google' ? (
              <>
                <Text style={styles.fieldLabel}>Google Calendar ID</Text>
                <TextInput
                  style={styles.input}
                  value={googleCalendarIdDraft}
                  onChangeText={setGoogleCalendarIdDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="primary or example@gmail.com"
                />

                <Text style={styles.deleteHint}>Connect your Google account to enable calendar sync.</Text>
              </>
            ) : calendarSyncProviderDraft === 'outlook' ? (
              <>
                <TextInput
                  style={styles.input}
                  value={outlookCalendarEmailDraft}
                  onChangeText={setOutlookCalendarEmailDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="name@example.com"
                />

                <Text style={styles.deleteHint}>Enter email and use as login ID</Text>
              </>
            ) : calendarSyncProviderDraft === 'apple' ? (
              <>
                <Text style={styles.fieldLabel}>Device Calendar</Text>
                {appleAvailableCalendars.length ? (
                  <View style={styles.pickerWrapper}>
                    <Picker
                      selectedValue={appleCalendarIdDraft}
                      onValueChange={(value) => {
                        const nextId = String(value || '');
                        const selectedCalendar = appleAvailableCalendars.find((entry) => entry.id === nextId);
                        setAppleCalendarIdDraft(nextId);
                        setAppleCalendarNameDraft(selectedCalendar?.title || '');
                      }}
                      style={styles.picker}
                    >
                      <Picker.Item label="Select a device calendar" value="" />
                      {appleAvailableCalendars.map((entry) => (
                        <Picker.Item key={entry.id} label={entry.title} value={entry.id} />
                      ))}
                    </Picker>
                  </View>
                ) : (
                  <Text style={styles.deleteHint}>Tap Connect to grant calendar access and load the writable calendars on this device.</Text>
                )}

                <Text style={styles.deleteHint}>This connects to a device calendar on this iPhone or iPad, not to an Apple ID email address.</Text>
                {!isAppleLocalSyncSupported ? (
                  <Text style={styles.deleteHint}>Apple iCalendar connect is disabled on this platform. Use an iOS device to connect.</Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.deleteHint}>This provider UI is ready, and sync wiring is coming soon. Please use Google for now.</Text>
            )}

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={[styles.primaryButton, styles.modalActionButton]}
                onPress={() => {
                  void handleCalendarSyncEditorConnect();
                }}
                disabled={
                  isConnectingGoogle
                  || isConnectingOutlook
                  || isConnectingApple
                  || isSavingCalendarSync
                }
              >
                <Text style={styles.primaryButtonText}>{isConnectingGoogle || isConnectingOutlook || isConnectingApple ? 'Opening…' : 'Connect'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setCalendarSyncProviderDraft('none');
                  setGoogleCalendarIdDraft(googleCalendarId);
                  setOutlookCalendarEmailDraft(outlookCalendarEmail);
                  setAppleCalendarIdDraft(appleCalendarId);
                  setAppleCalendarNameDraft(appleCalendarName);
                  setShowCalendarSyncEditor(false);
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      <Modal
        transparent
        visible={showDeleteConfirm}
        animationType="fade"
        onRequestClose={() => {
          setShowDeleteConfirm(false);
          setMessage(null);
        }}
      >
        <View style={[styles.modalOverlay, styles.deleteModalOverlay]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete account</Text>
            <Text style={styles.deleteHint}>This removes your account, events, and reminders permanently.</Text>
            <View style={styles.modalActionsRow}>
              <TouchableOpacity style={[styles.deleteButton, styles.modalActionButton]} onPress={() => void handleConfirmDelete()} disabled={isSaving}>
                <Text style={styles.deleteButtonText}>{isSaving ? 'Deleting…' : 'Yes, delete account'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setShowDeleteConfirm(false);
                  setMessage(null);
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {showMobileVerificationModal ? (
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Validate mobile phone</Text>
            <Text style={styles.deleteHint}>Enter the 6-digit code we sent by text to your mobile phone.</Text>

            <Text style={styles.fieldLabel}>Verification code</Text>
            <TextInput
              style={styles.input}
              value={mobileVerificationCode}
              onChangeText={(value) => {
                setMobileVerificationCode(value.replace(/\D/g, '').slice(0, 6));
                if (message) {
                  setMessage(null);
                }
              }}
              placeholder="6-digit code"
              keyboardType="number-pad"
              maxLength={6}
            />

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.modalActionButton,
                  (mobileVerificationCode.trim().length !== 6 || isMobileVerificationSubmitting) && styles.primaryButtonDisabled,
                ]}
                onPress={() => void handleVerifyMobileCode()}
                disabled={mobileVerificationCode.trim().length !== 6 || isMobileVerificationSubmitting}
              >
                <Text style={styles.primaryButtonText}>{isMobileVerificationSubmitting ? 'Verifying…' : 'Verify'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  void startMobileVerificationFlow();
                }}
                disabled={isMobileVerificationSubmitting}
              >
                <Text style={styles.secondaryButtonText}>Resend code</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.secondaryButton, { marginTop: 8 }]}
              onPress={() => setShowMobileVerificationModal(false)}
              disabled={isMobileVerificationSubmitting}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {showContactsModal ? (
        <View style={styles.contactsStandalonePanel}>
          <View style={styles.accountHeaderRow}>
            <View style={styles.accountHeaderLeft}>
              <Image source={require('./assets/icon.png')} style={styles.accountHeaderLogo} resizeMode="cover" />
              <View style={styles.accountHeaderTextWrap}>
                <Text style={styles.accountTitle}>Contacts</Text>
                <Text style={styles.accountSubtitle}>{contactsLastSyncedLabel}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={handleContactsBack}
            >
              <Text style={styles.secondaryButtonText}>Back</Text>
            </TouchableOpacity>
          </View>

          {activeContactsView !== 'none' && contactsMessage ? <Text style={styles.message}>{contactsMessage}</Text> : null}

          <View style={styles.contactsShell}>
            <View style={styles.contactsMainPane}>
              {!isEditingContact && activeContactsView === 'none' ? (
                <View style={styles.contactsLinksWrap}>
                  <View style={styles.contactsLinkItem}>
                    <TouchableOpacity
                      style={styles.contactsLinkButton}
                      onPress={() => {
                        setActiveContactsView('contacts');
                        setContactsDisplayMode('summary');
                        setActiveSummaryContactId(null);
                      }}
                    >
                      <Text style={styles.contactsLinkText}>Contacts</Text>
                    </TouchableOpacity>
                    <Text style={styles.contactsLinkDescription}>View and manage your contact list.</Text>
                  </View>

                  <View style={styles.contactsLinkItem}>
                    <TouchableOpacity
                      style={styles.contactsLinkButton}
                      onPress={() => {
                        setActiveContactsView('favorites');
                        setContactsDisplayMode('summary');
                        setActiveSummaryContactId(null);
                      }}
                    >
                      <Text style={styles.contactsLinkText}>Favorites</Text>
                    </TouchableOpacity>
                    <Text style={styles.contactsLinkDescription}>See only contacts marked as favorites.</Text>
                  </View>

                  <View style={styles.contactsLinkItem}>
                    <TouchableOpacity
                      style={styles.contactsLinkButton}
                      onPress={() => {
                        setActiveContactsView('groups');
                        setGroupsDisplayMode('summary');
                        setSelectedGroupId('');
                      }}
                    >
                      <Text style={styles.contactsLinkText}>Groups</Text>
                    </TouchableOpacity>
                    <Text style={styles.contactsLinkDescription}>Create and manage your contact groups.</Text>
                  </View>

                </View>
              ) : null}

              {isLoadingContacts ? (
                <Text style={styles.contactsEmptySubtext}>Loading contacts...</Text>
              ) : null}

              {!isLoadingContacts && isEditingContact && activeContactsView === 'contacts' ? (
                <ScrollView style={styles.contactsList} contentContainerStyle={styles.contactsListContent} keyboardShouldPersistTaps="handled">
                  <Text style={styles.sectionTitle}>{editingContactId ? 'Edit contact' : 'New contact'}</Text>

                  <Text style={styles.fieldLabel}>Email address</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.email}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, email: value }))}
                    onBlur={() => void handleContactEmailBlur()}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    placeholder="name@example.com"
                  />

                  <Text style={styles.fieldLabel}>First name</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.firstName}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, firstName: value }))}
                    placeholder="First name"
                  />

                  <Text style={styles.fieldLabel}>Last name</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.lastName}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, lastName: value }))}
                    placeholder="Last name"
                  />

                  <View style={styles.accountAddressBlock}>
                    <Text style={styles.fieldLabel}>Address</Text>

                    <TextInput
                      style={[styles.input, styles.accountCompactInput]}
                      value={contactAddressLine1}
                      onChangeText={setContactAddressLine1}
                      placeholder="Address line 1"
                    />

                    {contactAddressPredictions.length ? (
                      <View style={styles.addressSuggestionsList}>
                        {contactAddressPredictions.map((prediction) => (
                          <TouchableOpacity
                            key={prediction.placeId}
                            style={styles.addressSuggestionItem}
                            onPress={() => void applyContactAddressPrediction(prediction)}
                          >
                            <Text style={styles.addressSuggestionMainText} numberOfLines={1}>{prediction.mainText}</Text>
                            {prediction.secondaryText ? <Text style={styles.addressSuggestionSecondaryText} numberOfLines={1}>{prediction.secondaryText}</Text> : null}
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}

                    <TextInput
                      style={[styles.input, styles.accountCompactInput, !contactAddressLine2.trim() && styles.optionalAddressLine2Input]}
                      value={contactAddressLine2}
                      onChangeText={setContactAddressLine2}
                      placeholder="Address line 2"
                      placeholderTextColor="#94a3b8"
                    />

                    <TextInput
                      style={[styles.input, styles.accountCompactInput]}
                      value={contactAddressCity}
                      onChangeText={setContactAddressCity}
                      placeholder="City"
                    />

                    <View style={styles.accountAddressCityStateZipRow}>
                      <View style={[styles.accountInlineField, styles.accountStateField]}>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          value={contactAddressState}
                          onChangeText={(value) => setContactAddressState(value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2))}
                          placeholder="State"
                          autoCapitalize="characters"
                          maxLength={2}
                        />
                      </View>

                      <View style={[styles.accountInlineField, styles.accountZipField]}>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          value={contactAddressZip}
                          onChangeText={(value) => setContactAddressZip(value.replace(/\D/g, '').slice(0, 5))}
                          placeholder="ZIP"
                          keyboardType="number-pad"
                          maxLength={5}
                        />
                      </View>
                    </View>
                  </View>

                  <Text style={styles.fieldLabel}>Birth date</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.birthDate}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, birthDate: formatBirthDateInput(value) }))}
                    placeholder="mm/dd/yyyy"
                    keyboardType="number-pad"
                    maxLength={10}
                  />

                  <Text style={styles.fieldLabel}>Mobile phone</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.mobileNumber}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, mobileNumber: formatPhoneNumberInput(value) }))}
                    placeholder="(000) 000-0000"
                    keyboardType="phone-pad"
                  />

                  <Text style={styles.fieldLabel}>Company</Text>
                  <TextInput
                    style={styles.input}
                    value={contactDraft.company}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, company: value }))}
                    placeholder="Company"
                  />

                  <Text style={styles.fieldLabel}>Notes</Text>
                  <TextInput
                    style={[styles.input, styles.contactsNotesInput]}
                    value={contactDraft.notes}
                    onChangeText={(value) => setContactDraft((current) => ({ ...current, notes: value }))}
                    placeholder="Notes"
                    multiline
                  />

                  <View style={styles.modalActionsRow}>
                    <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={() => void saveContact()}>
                      <Text style={styles.primaryButtonText}>{editingContactId ? 'Save contact' : 'Add contact'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.secondaryButton, styles.modalActionButton]}
                      onPress={resetContactEditor}
                    >
                      <Text style={styles.secondaryButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              ) : null}

              {!isLoadingContacts && !isEditingContact && (activeContactsView === 'contacts' || activeContactsView === 'favorites') ? (
                <>
                  <View style={styles.contactsTopActions}>
                    {activeContactsView === 'contacts' ? (
                      <>
                        <TouchableOpacity style={[styles.secondaryButton, styles.contactsTopActionButton]} onPress={openNewContactEditor}>
                          <Text style={styles.secondaryButtonText}>New</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.secondaryButton, styles.contactsTopActionButton]}
                          onPress={() => void loadDeviceContactsForImport()}
                          disabled={isLoadingDeviceContacts}
                        >
                          <Text style={styles.secondaryButtonText}>{isLoadingDeviceContacts ? 'Loading…' : 'Import iPhone'}</Text>
                        </TouchableOpacity>
                      </>
                    ) : null}
                  </View>

                  {(activeContactsView === 'contacts' && !activeContacts.length)
                  || (activeContactsView === 'favorites' && !favoriteContacts.length) ? (
                    <View style={styles.contactsEmptyState}>
                      <Text style={styles.contactsEmptyIcon}>👥</Text>
                      <Text style={styles.contactsEmptyTitle}>You haven't added any contacts yet</Text>
                    </View>
                  ) : (
                    <ScrollView style={styles.contactsList} contentContainerStyle={styles.contactsListContent} keyboardShouldPersistTaps="handled">
                      {contactsPageItems.map((contact) => (
                        <TouchableOpacity
                          key={contact.id}
                          style={styles.contactsSummaryRow}
                          onPress={() => setActiveSummaryContactId(contact.id)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.contactsSummaryRowText} numberOfLines={1}>{`${getContactDisplayName(contact)} - ${getContactPrimaryChannelLabel(contact)}`}</Text>
                        </TouchableOpacity>
                      ))}

                      {contactsPageCount > 1 ? (
                        <View style={styles.groupsManagePaginationRow}>
                          <TouchableOpacity
                            style={[styles.secondaryButton, styles.groupsManagePageButton, contactsPage === 0 && styles.groupsManagePageButtonDisabled]}
                            disabled={contactsPage === 0}
                            onPress={() => setContactsPage((page) => Math.max(0, page - 1))}
                          >
                            <Text style={styles.secondaryButtonText}>Prev</Text>
                          </TouchableOpacity>

                          <Text style={styles.contactRowMeta}>{`${contactsPage + 1}/${contactsPageCount}`}</Text>

                          <TouchableOpacity
                            style={[styles.secondaryButton, styles.groupsManagePageButton, contactsPage >= contactsPageCount - 1 && styles.groupsManagePageButtonDisabled]}
                            disabled={contactsPage >= contactsPageCount - 1}
                            onPress={() => setContactsPage((page) => Math.min(contactsPageCount - 1, page + 1))}
                          >
                            <Text style={styles.secondaryButtonText}>Next</Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}
                    </ScrollView>
                  )}
                </>
              ) : null}

              {!isLoadingContacts && !isEditingContact && activeContactsView === 'groups' ? (
                <ScrollView
                  style={styles.contactsList}
                  contentContainerStyle={styles.contactsListContent}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="on-drag"
                  onScrollBeginDrag={() => Keyboard.dismiss()}
                >
                  <View style={styles.contactsTopActions}>
                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        showCreateGroupModal && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => setShowCreateGroupModal(true)}
                    >
                      <Text style={styles.secondaryButtonText}>New</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        groupsDisplayMode === 'summary' && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => {
                        setGroupsDisplayMode('summary');
                        setSelectedGroupId('');
                      }}
                    >
                      <Text style={styles.secondaryButtonText}>Summary</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.secondaryButton, styles.contactsTopActionButton]}
                      onPress={() => setShowCloneGroupModal(true)}
                    >
                      <Text style={styles.secondaryButtonText}>Clone</Text>
                    </TouchableOpacity>
                  </View>

                  {groupsDisplayMode === 'summary' ? (
                    <>
                      <Text style={styles.sectionTitle}>Groups summary</Text>
                      {contactGroups.length ? contactGroups.map((group) => (
                        <View key={group.id} style={styles.groupSummaryRow}>
                          <TouchableOpacity
                            style={styles.groupSummaryRowPressable}
                            onPress={() => {
                              setSelectedGroupId(group.id);
                              setGroupsDisplayMode('manage');
                              setContactsMessage(null);
                            }}
                            activeOpacity={0.8}
                          >
                            <Text style={[styles.contactsSummaryRowText, styles.groupsSummaryRowText]} numberOfLines={1}>{`${group.name} (${getGroupMemberCount(group)} members)`}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.deleteButton, styles.groupSummaryDeleteButton]}
                            onPress={() => setGroupDeleteCandidateId(group.id)}
                          >
                            <Text style={styles.deleteButtonText}>Delete</Text>
                          </TouchableOpacity>
                        </View>
                      )) : <Text style={styles.contactsEmptySubtext}>No groups yet. Use New to create one.</Text>}
                    </>
                  ) : null}

                  {groupsDisplayMode === 'manage' && selectedGroup ? (
                    <View style={styles.groupsManageScreen}>
                      <Text style={styles.sectionTitle}>{selectedGroup.name}</Text>
                      <Text style={styles.contactRowMeta}>{`${getGroupMemberCount(selectedGroup)} members`}</Text>

                      <View style={styles.contactsSummaryDetailsCard}>
                        <Text style={styles.fieldLabel}>Group name</Text>
                        <TextInput
                          style={styles.input}
                          value={selectedGroupNameDraft}
                          onChangeText={setSelectedGroupNameDraft}
                          placeholder="Group name"
                        />
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => void saveSelectedGroupName()}>
                          <Text style={styles.secondaryButtonText}>{groupNameSaveState === 'saved' ? 'Saved' : 'Change Name'}</Text>
                        </TouchableOpacity>

                        <Text style={styles.fieldLabel}>Group description</Text>
                        <TextInput
                          style={[styles.input, styles.contactsNotesInput]}
                          value={selectedGroupDescriptionDraft}
                          onChangeText={setSelectedGroupDescriptionDraft}
                          placeholder="Describe this group"
                          multiline
                        />
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => void saveSelectedGroupDescription()}>
                          <Text style={styles.secondaryButtonText}>{groupDescriptionSaveState === 'saved' ? 'Saved' : 'Change Description'}</Text>
                        </TouchableOpacity>

                        <View style={styles.groupsManageColumns}>
                          <View style={styles.groupsManageColumn}>
                            <Text style={styles.sectionTitle}>Group members</Text>
                            <TextInput
                              style={[styles.input, styles.groupSearchInput]}
                              value={groupMembersSearch}
                              onChangeText={setGroupMembersSearch}
                              placeholder="Search members"
                              placeholderTextColor="#94a3b8"
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                            {selectedGroupMembers.length ? (
                              <>
                                {selectedGroupMembersPageItems.length ? selectedGroupMembersPageItems.map((entry) => (
                                  <View key={entry.id} style={styles.contactRowCard}>
                                    <View style={styles.groupMemberHeaderRow}>
                                      <Text style={styles.contactRowName}>{getContactDisplayName(entry)}</Text>
                                      <TouchableOpacity
                                        style={styles.secondaryButton}
                                        onPress={() => void removeContactFromSelectedGroup(entry.id)}
                                      >
                                        <Text style={styles.secondaryButtonText}>Remove</Text>
                                      </TouchableOpacity>
                                    </View>
                                    <Text style={styles.contactRowMeta}>{getContactPrimaryChannelLabel(entry)}</Text>
                                  </View>
                                )) : <Text style={styles.contactsEmptySubtext}>{groupMembersSearch.trim() ? 'No members match your search.' : 'No members on this page.'}</Text>}

                                <View style={styles.groupsManagePaginationRow}>
                                  <TouchableOpacity
                                    style={[styles.secondaryButton, styles.groupsManagePageButton, selectedGroupMembersPage === 0 && styles.groupsManagePageButtonDisabled]}
                                    disabled={selectedGroupMembersPage === 0}
                                    onPress={() => setSelectedGroupMembersPage((page) => Math.max(0, page - 1))}
                                  >
                                    <Text style={styles.secondaryButtonText}>Prev</Text>
                                  </TouchableOpacity>

                                  <Text style={styles.contactRowMeta}>{`${selectedGroupMembersPage + 1}/${selectedGroupMembersPageCount}`}</Text>

                                  <TouchableOpacity
                                    style={[styles.secondaryButton, styles.groupsManagePageButton, selectedGroupMembersPage >= selectedGroupMembersPageCount - 1 && styles.groupsManagePageButtonDisabled]}
                                    disabled={selectedGroupMembersPage >= selectedGroupMembersPageCount - 1}
                                    onPress={() => setSelectedGroupMembersPage((page) => Math.min(selectedGroupMembersPageCount - 1, page + 1))}
                                  >
                                    <Text style={styles.secondaryButtonText}>Next</Text>
                                  </TouchableOpacity>
                                </View>
                              </>
                            ) : <Text style={styles.contactsEmptySubtext}>{groupMembersSearch.trim() ? 'No members match your search.' : 'No members in this group yet.'}</Text>}
                          </View>

                          <View style={styles.groupsManageColumn}>
                            <Text style={styles.sectionTitle}>{`Add contact to ${selectedGroup.name}`}</Text>
                            <TextInput
                              style={[styles.input, styles.groupSearchInput]}
                              value={groupAddContactsSearch}
                              onChangeText={setGroupAddContactsSearch}
                              placeholder="Search contacts"
                              placeholderTextColor="#94a3b8"
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                            {contactsAvailableForSelectedGroup.length ? (
                              <>
                                {selectedGroupAddContactsPageItems.length ? selectedGroupAddContactsPageItems.map((entry) => (
                                  <View key={entry.id} style={styles.contactRowCard}>
                                    <View style={styles.groupMemberHeaderRow}>
                                      <View style={styles.accountInlineField}>
                                        <Text style={styles.contactRowName}>{getContactDisplayName(entry)}</Text>
                                        <Text style={styles.contactRowMeta}>{getContactPrimaryChannelLabel(entry)}</Text>
                                      </View>
                                      <TouchableOpacity
                                        style={[styles.primaryButton, styles.groupsManageAddButton]}
                                        onPress={() => void addSelectedContactToSelectedGroup(entry.id)}
                                      >
                                        <Text style={styles.primaryButtonText}>Add</Text>
                                      </TouchableOpacity>
                                    </View>
                                  </View>
                                )) : <Text style={styles.contactsEmptySubtext}>{groupAddContactsSearch.trim() ? 'No contacts match your search.' : 'No contacts on this page.'}</Text>}

                                <View style={styles.groupsManagePaginationRow}>
                                  <TouchableOpacity
                                    style={[styles.secondaryButton, styles.groupsManagePageButton, selectedGroupAddContactsPage === 0 && styles.groupsManagePageButtonDisabled]}
                                    disabled={selectedGroupAddContactsPage === 0}
                                    onPress={() => setSelectedGroupAddContactsPage((page) => Math.max(0, page - 1))}
                                  >
                                    <Text style={styles.secondaryButtonText}>Prev</Text>
                                  </TouchableOpacity>

                                  <Text style={styles.contactRowMeta}>{`${selectedGroupAddContactsPage + 1}/${selectedGroupAddContactsPageCount}`}</Text>

                                  <TouchableOpacity
                                    style={[styles.secondaryButton, styles.groupsManagePageButton, selectedGroupAddContactsPage >= selectedGroupAddContactsPageCount - 1 && styles.groupsManagePageButtonDisabled]}
                                    disabled={selectedGroupAddContactsPage >= selectedGroupAddContactsPageCount - 1}
                                    onPress={() => setSelectedGroupAddContactsPage((page) => Math.min(selectedGroupAddContactsPageCount - 1, page + 1))}
                                  >
                                    <Text style={styles.secondaryButtonText}>Next</Text>
                                  </TouchableOpacity>
                                </View>
                              </>
                            ) : (
                              <Text style={styles.contactsEmptySubtext}>{groupAddContactsSearch.trim() ? 'No contacts match your search.' : 'No remaining contacts to add.'}</Text>
                            )}
                          </View>
                        </View>
                      </View>

                      <View style={styles.modalActionsRow}>
                        <TouchableOpacity
                          style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                          onPress={() => {
                            setSelectedGroupId('');
                            setGroupsDisplayMode('summary');
                          }}
                        >
                          <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Back to Summary</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.deleteButton, styles.contactsSummaryActionButton]}
                          onPress={() => setGroupDeleteCandidateId(selectedGroup.id)}
                        >
                          <Text style={styles.deleteButtonText} numberOfLines={1}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}
                </ScrollView>
              ) : null}
            </View>
          </View>

          <Modal
            transparent
            visible={showCloneGroupModal}
            animationType="fade"
            onRequestClose={() => setShowCloneGroupModal(false)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>Clone group</Text>
                <Text style={styles.fieldLabel}>Choose a group to duplicate</Text>
                <ScrollView style={styles.cloneGroupModalList} contentContainerStyle={styles.cloneGroupModalListContent}>
                  {contactGroups.length ? contactGroups.map((group) => (
                    <TouchableOpacity
                      key={group.id}
                      style={styles.contactRowCard}
                      onPress={() => { void cloneContactGroup(group.id); }}
                    >
                      <Text style={styles.contactRowName}>{group.name}</Text>
                      <Text style={styles.contactRowMeta}>{`${getGroupMemberCount(group)} members`}</Text>
                    </TouchableOpacity>
                  )) : <Text style={styles.contactsEmptySubtext}>No groups available to clone.</Text>}
                </ScrollView>
                <View style={styles.modalActionsRow}>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.modalActionButton]}
                    onPress={() => setShowCloneGroupModal(false)}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            transparent
            visible={groupDeleteCandidateId !== null}
            animationType="fade"
            onRequestClose={() => setGroupDeleteCandidateId(null)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>Delete group?</Text>
                <Text style={styles.deleteHint}>
                  {contactGroups.find((group) => group.id === groupDeleteCandidateId)?.name
                    ? `This will permanently delete "${contactGroups.find((group) => group.id === groupDeleteCandidateId)?.name}" and remove its members from the group.`
                    : 'This will permanently delete this group.'}
                </Text>
                <Text style={styles.deleteHint}>Please confirm this action.</Text>
                <View style={styles.modalActionsRow}>
                  <TouchableOpacity
                    style={[styles.deleteButton, styles.modalActionButton]}
                    onPress={() => {
                      if (groupDeleteCandidateId) {
                        void deleteSelectedGroup(groupDeleteCandidateId);
                      }
                    }}
                  >
                    <Text style={styles.deleteButtonText}>Yes, delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.modalActionButton]}
                    onPress={() => setGroupDeleteCandidateId(null)}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            transparent
            visible={showCreateGroupModal}
            animationType="fade"
            onRequestClose={() => {
              setShowCreateGroupModal(false);
              setNewGroupName('');
              setNewGroupDescription('');
            }}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>Create group</Text>
                <TextInput
                  style={styles.input}
                  value={newGroupName}
                  onChangeText={setNewGroupName}
                  placeholder="Family, Team, Clients..."
                />
                <Text style={styles.fieldLabel}>Group description</Text>
                <TextInput
                  style={[styles.input, styles.contactsNotesInput]}
                  value={newGroupDescription}
                  onChangeText={setNewGroupDescription}
                  placeholder="Describe this group"
                  multiline
                />
                <View style={styles.modalActionsRow}>
                  <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={() => void createContactGroup()}>
                    <Text style={styles.primaryButtonText}>Create group</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.modalActionButton]}
                    onPress={() => {
                      setShowCreateGroupModal(false);
                      setNewGroupName('');
                      setNewGroupDescription('');
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          <Modal
            transparent
            visible={activeSummaryContact !== null}
            animationType="fade"
            onRequestClose={() => setActiveSummaryContactId(null)}
          >
            <View style={[styles.modalOverlay, styles.contactSummaryModalOverlay]}>
              {activeSummaryContact ? (
                <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                  <Text style={styles.modalTitle}>Contact Summary</Text>

                  <View style={styles.contactsSummaryDetailsCard}>
                    <Text style={styles.contactRowName}>{getContactDisplayName(activeSummaryContact)}</Text>
                    {activeSummaryContact.email ? <Text style={styles.contactRowMeta}>{activeSummaryContact.email}</Text> : null}
                    {activeSummaryContact.mobileNumber ? <Text style={styles.contactRowMeta}>{activeSummaryContact.mobileNumber}</Text> : null}
                    {activeSummaryContact.company ? <Text style={styles.contactRowMeta}>{`Company: ${activeSummaryContact.company}`}</Text> : null}
                    {activeSummaryContact.birthDate ? <Text style={styles.contactRowMeta}>{`Birth date: ${activeSummaryContact.birthDate}`}</Text> : null}
                    {activeSummaryContact.address ? <Text style={styles.contactRowMeta}>{`Address: ${activeSummaryContact.address}`}</Text> : null}
                    {activeSummaryContact.notes ? <Text style={styles.contactRowMeta}>{`Notes: ${activeSummaryContact.notes}`}</Text> : null}
                  </View>

                  <View style={styles.modalActionsRow}>
                    <TouchableOpacity
                      style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                      onPress={() => {
                        openEditContactEditor(activeSummaryContact);
                        setActiveSummaryContactId(null);
                      }}
                    >
                      <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                      onPress={() => void toggleFavoriteContact(activeSummaryContact.id)}
                    >
                      <Text style={styles.contactsSummaryActionText} numberOfLines={1}>{activeSummaryContact.isFavorite ? 'Unfavorite' : 'Favorite'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.deleteButton, styles.contactsSummaryActionButton]}
                      onPress={() => {
                        void permanentlyDeleteContact(activeSummaryContact.id);
                        setActiveSummaryContactId(null);
                      }}
                    >
                      <Text style={styles.deleteButtonText} numberOfLines={1}>Delete</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                      onPress={() => setActiveSummaryContactId(null)}
                    >
                      <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </View>
          </Modal>

          <Modal
            transparent
            visible={showDeviceContactsImportModal}
            animationType="fade"
            onRequestClose={() => setShowDeviceContactsImportModal(false)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.deviceContactsImportModalCard]}>
                <Text style={styles.modalTitle}>Import iPhone Contacts</Text>
                <Text style={styles.deleteHint}>Select any iPhone contact below to import it immediately, or use Add all to import every eligible contact at once.</Text>

                <View style={styles.contactsTopActions}>
                  <TouchableOpacity
                    style={[
                      styles.primaryButton,
                      styles.contactsTopActionButton,
                      importableDeviceContactsCount === 0 && styles.primaryButtonDisabled,
                    ]}
                    onPress={() => void importDeviceContacts(deviceContactsToImport)}
                    disabled={importableDeviceContactsCount === 0}
                  >
                    <Text style={styles.primaryButtonText}>Add all</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.contactsTopActionButton]}
                    onPress={() => setShowDeviceContactsImportModal(false)}
                  >
                    <Text style={styles.secondaryButtonText}>Close</Text>
                  </TouchableOpacity>
                </View>

                {deviceContactsImportRows.length ? (
                  <ScrollView style={styles.contactsList} contentContainerStyle={styles.contactsListContent} keyboardShouldPersistTaps="handled">
                    {deviceContactsImportRows.map((entry) => (
                      <View key={entry.id} style={styles.contactRowCard}>
                        <Text style={styles.contactRowName}>{getContactDisplayName(entry)}</Text>
                        <Text style={styles.contactRowMeta}>{getContactPrimaryChannelLabel(entry)}</Text>
                        {entry.company ? <Text style={styles.contactRowMeta}>{`Company: ${entry.company}`}</Text> : null}
                        <View style={styles.contactsCardActionsRow}>
                          <TouchableOpacity
                            style={[
                              styles.primaryButton,
                              styles.contactInlineActionButton,
                              entry.alreadyAdded && styles.primaryButtonDisabled,
                            ]}
                            onPress={() => void importDeviceContacts([entry])}
                            disabled={entry.alreadyAdded}
                          >
                            <Text style={styles.primaryButtonText}>{entry.alreadyAdded ? 'Added' : 'Add'}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}
                  </ScrollView>
                ) : (
                  <Text style={styles.contactsEmptySubtext}>No iPhone contacts are available to import.</Text>
                )}
              </View>
            </View>
          </Modal>

        </View>
      ) : null}

      {showContactSupportModal ? (
        <KeyboardAvoidingView
          style={styles.contactSupportStandalonePanel}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={20}
        >
          <View style={styles.accountHeaderRow}>
            <View style={styles.accountHeaderLeft}>
              <Image source={require('./assets/icon.png')} style={styles.accountHeaderLogo} resizeMode="cover" />
              <View style={styles.accountHeaderTextWrap}>
                <Text style={styles.accountTitle}>Contact Us</Text>
                <Text style={styles.accountSubtitle}>Send a message to support.</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.secondaryButton} onPress={closeContactSupportModal}>
              <Text style={styles.secondaryButtonText}>Back to Settings</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.contactSupportStandaloneForm}
            contentContainerStyle={styles.contactSupportStandaloneFormContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              style={styles.input}
              value={contactSupportSubject}
              onChangeText={(value) => {
                setContactSupportSubject(value);
                if (contactSupportError) {
                  setContactSupportError(null);
                }
              }}
              placeholder="Subject"
              maxLength={120}
            />

            <Text style={styles.fieldLabel}>Message</Text>
            <TextInput
              style={[styles.input, styles.contactSupportMessageInput]}
              value={contactSupportMessage}
              onChangeText={(value) => {
                setContactSupportMessage(value.slice(0, 255));
                if (contactSupportError) {
                  setContactSupportError(null);
                }
              }}
              placeholder="How can we help?"
              multiline
              maxLength={255}
              textAlignVertical="top"
            />
            <Text style={styles.contactsEmptySubtext}>{`${contactSupportMessage.length}/255`}</Text>
            {contactSupportError ? <Text style={styles.contactSupportErrorText}>{contactSupportError}</Text> : null}

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.modalActionButton,
                  (!contactSupportSubject.trim() || !contactSupportMessage.trim() || isSendingContactSupport) && styles.primaryButtonDisabled,
                ]}
                onPress={() => void handleSendContactSupportMessage()}
                disabled={isSendingContactSupport || !contactSupportSubject.trim() || !contactSupportMessage.trim()}
              >
                <Text style={styles.primaryButtonText}>{isSendingContactSupport ? 'Sending...' : 'Send'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={closeContactSupportModal}
                disabled={isSendingContactSupport}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : null}

      {!showContactsModal && !showContactSupportModal ? (
      <View style={styles.accountCard}>
        <View style={styles.accountHeaderRow}>
          <View style={styles.accountHeaderLeft}>
            <Image source={require('./assets/icon.png')} style={styles.accountHeaderLogo} resizeMode="cover" />
            <View style={styles.accountHeaderTextWrap}>
              <Text style={styles.accountTitle}>Settings</Text>
              <Text style={styles.accountSubtitle}>{user.email}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.secondaryButton} onPress={handleSettingsBack}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.accountMainPane}>
          {activeAccountAction === 'none' ? (
          <View style={styles.settingsLinksWrap}>
            <View style={styles.settingsLinkItem}>
              <TouchableOpacity style={styles.settingsLinkButton} onPress={() => setActiveAccountAction('profile')}>
                <Text style={styles.settingsLinkText}>Account</Text>
              </TouchableOpacity>
              <Text style={styles.settingsLinkDescription}>Update your profile details and manage account security.</Text>
            </View>

            <View style={styles.settingsLinkItem}>
              <TouchableOpacity style={styles.settingsLinkButton} onPress={() => setActiveAccountAction('settings')}>
                <Text style={styles.settingsLinkText}>Preferences</Text>
              </TouchableOpacity>
              <Text style={styles.settingsLinkDescription}>Choose reminder delivery and default time settings.</Text>
            </View>

            <View style={styles.settingsLinkItem}>
              <TouchableOpacity
                style={styles.settingsLinkButton}
                onPress={() => {
                  setMessage(null);
                  setContactSupportError(null);
                  setShowContactSupportModal(true);
                }}
              >
                <Text style={styles.settingsLinkText}>Contact Us</Text>
              </TouchableOpacity>
              <Text style={styles.settingsLinkDescription}>Send a message to support if you need help.</Text>
            </View>
          </View>
          ) : null}

            {activeAccountAction !== 'none' && message ? <Text style={styles.message}>{message}</Text> : null}

            {activeAccountAction === 'profile' ? (
              <>
                <Text style={styles.sectionTitle}>Profile</Text>
                <View style={styles.accountDetailsColumns}>
                  <View style={styles.accountDetailsPrimaryColumn}>
                    <View style={styles.accountProfileFieldStack}>
                      <View style={styles.accountInlineField}>
                        <Text style={styles.fieldLabel}>First name</Text>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          placeholder="First name"
                          value={firstName}
                          onChangeText={(value) => {
                            setFirstName(value);
                            if (message) {
                              setMessage(null);
                            }
                          }}
                        />
                      </View>

                      <View style={styles.accountInlineField}>
                        <Text style={styles.fieldLabel}>Last name</Text>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          placeholder="Last name"
                          value={lastName}
                          onChangeText={(value) => {
                            setLastName(value);
                            if (message) {
                              setMessage(null);
                            }
                          }}
                        />
                      </View>

                      <View style={styles.accountInlineField}>
                        <Text style={styles.fieldLabel}>Mobile phone</Text>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          placeholder="(000) 000-0000"
                          value={mobileNumber}
                          onChangeText={(value) => {
                            setMobileNumber(formatPhoneNumberInput(value));
                            if (message) {
                              setMessage(null);
                            }
                          }}
                          keyboardType="phone-pad"
                        />
                      </View>

                      <View style={styles.accountInlineField}>
                        <Text style={styles.fieldLabel}>Birth date</Text>
                        <TextInput
                          style={[styles.input, styles.accountCompactInput]}
                          placeholder="mm/dd/yyyy"
                          value={birthDate}
                          onChangeText={(value) => {
                            setBirthDate(formatBirthDateInput(value));
                            if (message) {
                              setMessage(null);
                            }
                          }}
                          keyboardType="number-pad"
                          maxLength={10}
                        />
                      </View>
                    </View>
                  </View>
                </View>

                <View style={styles.passwordSection}>
                  <View style={styles.accountActionButtonsRow}>
                    <TouchableOpacity style={[styles.passwordToggleRow, styles.accountActionButton, styles.accountChangePasswordButton]} onPress={() => setShowPasswordModal(true)} activeOpacity={0.8}>
                      <Text style={styles.accountChangePasswordButtonText}>Change Password</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.deleteButton, styles.accountActionButton]} onPress={() => void handleDelete()} disabled={isSaving}>
                      <Text style={styles.deleteButtonText}>Delete account</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            ) : null}

            {activeAccountAction === 'settings' ? (
              <View style={styles.passwordSection}>
                <Text style={styles.sectionTitle}>Reminder notifications</Text>

                <Text style={styles.preferenceSubheading}>Delivery type</Text>
                <View style={styles.deliveryPrimaryRow}>
                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption]} onPress={() => void handleDeliveryToggle('device')} activeOpacity={0.8}>
                    <View style={styles.passwordCheckbox}>
                      {deliveryDevice ? <View style={styles.passwordCheckboxChecked} /> : null}
                    </View>
                    <Text style={styles.preferenceToggleText}>Device</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.deviceInstructionLinkRow}
                  onPress={() => setShowDeviceNotificationInstructions(true)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.deviceInstructionLinkText}>Device Notification Instructions</Text>
                </TouchableOpacity>

                <View style={styles.deliveryOptionsRow}>
                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption]} onPress={() => void handleDeliveryToggle('email')} activeOpacity={0.8}>
                    <View style={styles.passwordCheckbox}>
                      {deliveryEmail ? <View style={styles.passwordCheckboxChecked} /> : null}
                    </View>
                    <Text style={styles.preferenceToggleText}>Email</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption]} onPress={() => void handleDeliveryToggle('text')} activeOpacity={0.8}>
                    <View style={styles.passwordCheckbox}>
                      {deliveryText ? <View style={styles.passwordCheckboxChecked} /> : null}
                    </View>
                    <Text style={styles.preferenceToggleText}>Text</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption, styles.preferenceToggleDisabled]} disabled activeOpacity={1}>
                    <View style={[styles.passwordCheckbox, styles.passwordCheckboxDisabled]} />
                    <Text style={styles.preferenceToggleDisabledText}>Voice</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.deliveryVerificationHint}>
                  {isMobileNumberVerified
                    ? 'Mobile phone is validated for text reminders.'
                    : 'Mobile phone is not validated for text reminders. Enabling text will send an SMS Opt In message.'}
                </Text>

                <TouchableOpacity style={styles.preferenceToggleRow} onPress={handleReminderSoundOffToggle} activeOpacity={0.8}>
                  <View style={styles.passwordCheckbox}>
                    {reminderSoundOff ? <View style={styles.passwordCheckboxChecked} /> : null}
                  </View>
                  <Text style={styles.preferenceToggleText}>Reminder notification sound off?</Text>
                </TouchableOpacity>

                <View style={{ marginTop: 12 }}>
                  <Text style={styles.sectionTitle}>Time defaults</Text>
                  <View style={styles.defaultReminderTimeRow}>
                    <Text style={styles.preferenceSubheading}>Reminder time</Text>
                    <Text style={styles.preferenceHelperText}>{formatReminderTimeLabel(defaultReminderHour, defaultReminderMinute)}</Text>
                    <TouchableOpacity
                      style={styles.defaultReminderTimeChangeButton}
                      onPress={() => {
                        setDefaultReminderDraftHour(defaultReminderHour);
                        setDefaultReminderDraftMinute(defaultReminderMinute);
                        setDefaultReminderDraftClockInterval(defaultReminderClockInterval);
                        setShowDefaultReminderTimeEditor(true);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.passwordToggleText}>Change</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={[styles.defaultReminderTimeRow, { marginTop: 8 }]}>
                    <Text style={styles.preferenceSubheading}>Time zone</Text>
                    <Text style={styles.preferenceHelperText}>{defaultReminderTimeZone}</Text>
                    <TouchableOpacity
                      style={styles.defaultReminderTimeChangeButton}
                      onPress={() => {
                        setDefaultReminderTimeZoneDraft(defaultReminderTimeZone);
                        setShowReminderTimeZoneEditor(true);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.passwordToggleText}>Change</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={[styles.defaultReminderTimeRow, { marginTop: 8 }]}>
                    <Text style={styles.preferenceSubheading}>Clock interval</Text>
                    <View style={styles.clockIntervalOptionsRow}>
                      {([
                        { value: 1 as const, label: '1 Minute' },
                        { value: 5 as const, label: '5 Minute' },
                        { value: 15 as const, label: '15 Minute' },
                      ]).map((option) => (
                        <TouchableOpacity
                          key={option.value}
                          style={[styles.preferenceToggleRow, styles.clockIntervalOption]}
                          onPress={() => void handleSelectClockInterval(option.value)}
                          activeOpacity={0.8}
                          disabled={isSavingDefaultReminderTime}
                        >
                          <View style={styles.passwordCheckbox}>
                            {defaultReminderClockInterval === option.value ? <View style={styles.passwordCheckboxChecked} /> : null}
                          </View>
                          <Text style={styles.preferenceToggleText}>{option.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                </View>
              </View>
            ) : null}

            {activeAccountAction === 'calendar-sync' ? (
              <View style={styles.passwordSection}>
                <Text style={styles.sectionTitle}>Calendar sync</Text>
                <View style={styles.calendarSyncHeaderInline}>
                  <TouchableOpacity
                    style={[
                      styles.calendarSyncAutoToggle,
                      isGoogleAutoSyncEnabled ? styles.calendarSyncAutoToggleEnabled : styles.calendarSyncAutoToggleDisabled,
                    ]}
                    onPress={() => void handleToggleGoogleAutoSync()}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.calendarSyncAutoToggleText,
                        isGoogleAutoSyncEnabled ? styles.calendarSyncAutoToggleTextEnabled : styles.calendarSyncAutoToggleTextDisabled,
                      ]}
                    >
                      {isGoogleAutoSyncEnabled ? 'Auto-sync enabled' : 'Auto-sync disabled'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <View style={{ marginTop: 8 }}>
                  <View style={styles.calendarSyncRowsWrap}>
                <View style={styles.calendarSyncRow}>
                  <View style={styles.calendarSyncProviderColumn}>
                    <Text style={styles.calendarSyncProviderLabel}>Google</Text>
                    <Text style={styles.calendarSyncProviderSubtext}>
                      {isGoogleConfigured ? `Google ID: ${googleCalendarId}` : 'Google ID: Not configured'}
                    </Text>
                    {isGoogleConfigured ? (
                      <TouchableOpacity
                        style={[styles.primaryButton, styles.googleSyncInlineButton]}
                        onPress={() => void handlePushGoogleCalendar()}
                        disabled={isPushingGoogleCalendar}
                      >
                        <Text style={[styles.primaryButtonText, styles.calendarSyncPrimaryButtonText]}>{isPushingGoogleCalendar ? 'Syncing…' : 'Manual Sync'}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <View style={styles.calendarSyncDetailsColumn}>
                    <Text style={styles.calendarSyncStatusColumn}>
                      Connect Status:{' '}
                      <Text style={
                        googleSyncStatus === 'synched'
                          ? styles.calendarSyncStatusConnectedText
                          : googleSyncStatus === 'paused'
                            ? styles.calendarSyncStatusPausedText
                            : styles.calendarSyncStatusNotConnectedText
                      }>{googleSyncStatus === 'synched' ? 'Connected' : googleSyncStatus === 'paused' ? 'Paused' : 'Disconnected'}</Text>
                    </Text>
                    <View style={styles.calendarSyncRowActions}>
                    {googleSyncStatus === 'not-synched' || googleSyncStatus === 'disconnected' ? (
                      <TouchableOpacity
                        style={styles.calendarSyncActionTextButton}
                        onPress={() => void handleConnectGoogleFromSection()}
                        disabled={isConnectingGoogle || isUpdatingGoogleConnection}
                      >
                        <Text style={styles.calendarSyncActionText}>{isConnectingGoogle ? 'Opening…' : 'Connect'}</Text>
                      </TouchableOpacity>
                    ) : null}

                    {googleSyncStatus === 'synched' ? (
                      <>
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => void handlePauseGoogle()}
                          disabled={isUpdatingGoogleConnection}
                        >
                          <Text style={styles.calendarSyncActionText}>{isUpdatingGoogleConnection ? 'Working…' : 'Pause'}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => void handleRemoveGoogleConnection()}
                          disabled={isUpdatingGoogleConnection}
                        >
                          <Text style={styles.calendarSyncActionText}>{isUpdatingGoogleConnection ? 'Working…' : 'Remove'}</Text>
                        </TouchableOpacity>
                      </>
                    ) : null}

                    {googleSyncStatus === 'paused' ? (
                      <>
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => void handleConnectGoogleFromSection()}
                          disabled={isConnectingGoogle || isUpdatingGoogleConnection}
                        >
                          <Text style={styles.calendarSyncActionText}>{isConnectingGoogle ? 'Opening…' : 'Connect'}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => void handleRemoveGoogleConnection()}
                          disabled={isUpdatingGoogleConnection}
                        >
                          <Text style={styles.calendarSyncActionText}>{isUpdatingGoogleConnection ? 'Working…' : 'Remove'}</Text>
                        </TouchableOpacity>
                      </>
                    ) : null}
                    </View>
                  </View>
                </View>

                <View style={styles.calendarSyncRow}>
                  <View style={styles.calendarSyncProviderColumn}>
                    <Text style={styles.calendarSyncProviderLabel}>Apple</Text>
                    <Text style={styles.calendarSyncProviderSubtext}>
                      {isAppleConfigured
                        ? `Selected Calendar: ${appleCalendarName || 'Unnamed calendar'}`
                        : 'Selected Calendar: Not configured'}
                    </Text>
                    {isAppleConfigured ? (
                      <TouchableOpacity
                        style={[styles.primaryButton, styles.googleSyncInlineButton]}
                        onPress={() => void handlePushAppleCalendar()}
                        disabled={isPushingAppleCalendar}
                      >
                        <Text style={[styles.primaryButtonText, styles.calendarSyncPrimaryButtonText]}>{isPushingAppleCalendar ? 'Syncing…' : 'Manual Sync'}</Text>
                      </TouchableOpacity>
                    ) : null}
                    {!isAppleLocalSyncSupported ? (
                      <Text style={styles.calendarSyncProviderSubtext}>Connect is available on iOS only.</Text>
                    ) : null}
                  </View>
                  <View style={styles.calendarSyncDetailsColumn}>
                    <Text style={styles.calendarSyncStatusColumn}>
                      Connect Status:{' '}
                      <Text style={
                        appleSyncStatus === 'synched'
                          ? styles.calendarSyncStatusConnectedText
                          : appleSyncStatus === 'paused'
                            ? styles.calendarSyncStatusPausedText
                            : styles.calendarSyncStatusNotConnectedText
                      }>{appleSyncStatus === 'synched' ? 'Connected' : appleSyncStatus === 'paused' ? 'Paused' : 'Disconnected'}</Text>
                    </Text>
                    <View style={styles.calendarSyncRowActions}>
                      {appleSyncStatus === 'not-synched' || appleSyncStatus === 'disconnected' ? (
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => void handleConnectAppleFromSection()}
                          disabled={isConnectingApple || isUpdatingAppleConnection || !isAppleLocalSyncSupported}
                        >
                          <Text style={styles.calendarSyncActionText}>{isConnectingApple ? 'Opening…' : 'Connect'}</Text>
                        </TouchableOpacity>
                      ) : null}

                      {appleSyncStatus === 'synched' ? (
                        <>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handlePauseApple()}
                            disabled={isUpdatingAppleConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingAppleConnection ? 'Working…' : 'Pause'}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handleRemoveAppleConnection()}
                            disabled={isUpdatingAppleConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingAppleConnection ? 'Working…' : 'Remove'}</Text>
                          </TouchableOpacity>
                        </>
                      ) : null}

                      {appleSyncStatus === 'paused' ? (
                        <>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handleConnectAppleFromSection()}
                            disabled={isConnectingApple || isUpdatingAppleConnection || !isAppleLocalSyncSupported}
                          >
                            <Text style={styles.calendarSyncActionText}>{isConnectingApple ? 'Opening…' : 'Connect'}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handleRemoveAppleConnection()}
                            disabled={isUpdatingAppleConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingAppleConnection ? 'Working…' : 'Remove'}</Text>
                          </TouchableOpacity>
                        </>
                      ) : null}
                    </View>
                  </View>
                </View>

                <View style={[styles.calendarSyncRow, styles.calendarSyncRowLast]}>
                  <View style={styles.calendarSyncProviderColumn}>
                    <Text style={styles.calendarSyncProviderLabel}>Outlook</Text>
                    <Text style={styles.calendarSyncProviderSubtext}>
                      {isOutlookConfigured ? `Outlook Email: ${outlookCalendarEmail}` : 'Outlook Email: Not configured'}
                    </Text>
                  </View>
                  <View style={styles.calendarSyncDetailsColumn}>
                    <Text style={styles.calendarSyncStatusColumn}>
                      Connect Status:{' '}
                      <Text style={
                        outlookSyncStatus === 'synched'
                          ? styles.calendarSyncStatusConnectedText
                          : outlookSyncStatus === 'paused'
                            ? styles.calendarSyncStatusPausedText
                            : styles.calendarSyncStatusNotConnectedText
                      }>{outlookSyncStatus === 'synched' ? 'Connected' : outlookSyncStatus === 'paused' ? 'Paused' : 'Disconnected'}</Text>
                    </Text>
                    <View style={styles.calendarSyncRowActions}>
                      {outlookSyncStatus === 'not-synched' || outlookSyncStatus === 'disconnected' ? (
                        <TouchableOpacity
                          style={styles.calendarSyncActionTextButton}
                          onPress={() => {}}
                        >
                          <Text style={styles.calendarSyncActionText}>Disabled</Text>
                        </TouchableOpacity>
                      ) : null}

                      {outlookSyncStatus === 'synched' ? (
                        <>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handlePauseOutlook()}
                            disabled={isUpdatingOutlookConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingOutlookConnection ? 'Working…' : 'Pause'}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handleRemoveOutlookConnection()}
                            disabled={isUpdatingOutlookConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingOutlookConnection ? 'Working…' : 'Remove'}</Text>
                          </TouchableOpacity>
                        </>
                      ) : null}

                      {outlookSyncStatus === 'paused' ? (
                        <>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => {}}
                          >
                            <Text style={styles.calendarSyncActionText}>Disabled</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.calendarSyncActionTextButton}
                            onPress={() => void handleRemoveOutlookConnection()}
                            disabled={isUpdatingOutlookConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isUpdatingOutlookConnection ? 'Working…' : 'Remove'}</Text>
                          </TouchableOpacity>
                        </>
                      ) : null}
                    </View>
                  </View>
                </View>
              </View>

            </View>
              </View>
            ) : null}

            {activeAccountAction === 'profile' ? (
              <TouchableOpacity style={styles.primaryButton} onPress={handleSaveProfile} disabled={isSaving}>
                <Text style={styles.primaryButtonText}>{isSaving ? 'Saving…' : 'Save Details'}</Text>
              </TouchableOpacity>
            ) : null}
        </View>
      </View>
      ) : null}

    </ScrollView>
  );
}

const MIGRATION_TIMEOUT_MS = 6000;
const APP_SESSION_KEY = 'special-date-app-session';

interface AppSessionState {
  userId: string;
  showAccount: boolean;
}

export default function App() {
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [currentUser, setCurrentUser] = useState<StoredUser | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [requestedAccountAction, setRequestedAccountAction] = useState<'contacts' | 'calendar-sync' | null>(null);
  const [shouldReturnToLandingFromAccount, setShouldReturnToLandingFromAccount] = useState(false);
  const [isMigratingData, setIsMigratingData] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [showTitleScreen, setShowTitleScreen] = useState(true);
  const [migrationSummary, setMigrationSummary] = useState<string | null>(null);
  const [accountReminderTimeZone, setAccountReminderTimeZone] = useState(getDeviceTimeZone());
  const [biometricUnlockState, setBiometricUnlockState] = useState<'checking' | 'ready' | 'unsupported' | 'failed'>('checking');
  const titleScreenScale = useRef(new Animated.Value(0.6)).current;
  const titleScreenOpacity = useRef(new Animated.Value(0)).current;
  const titleScreenShimmerX = useRef(new Animated.Value(-170)).current;
  const titleScreenSparkleOpacity = useRef(new Animated.Value(0.15)).current;

  useEffect(() => {
    if (currentUser) {
      setShowTitleScreen(false);
      return;
    }

    const titleScreenTimer = setTimeout(() => {
      Animated.timing(titleScreenOpacity, {
        toValue: 0,
        duration: 900,
        useNativeDriver: true,
      }).start(() => setShowTitleScreen(false));
    }, 3300);

    return () => clearTimeout(titleScreenTimer);
  }, [currentUser, titleScreenOpacity]);

  useEffect(() => {
    if (currentUser) {
      titleScreenOpacity.setValue(1);
      titleScreenScale.setValue(1);
      titleScreenShimmerX.setValue(-170);
      titleScreenSparkleOpacity.setValue(0.15);
      return;
    }

    Animated.parallel([
      Animated.timing(titleScreenOpacity, {
        toValue: 1,
        duration: 1100,
        useNativeDriver: true,
      }),
      Animated.spring(titleScreenScale, {
        toValue: 1,
        tension: 18,
        friction: 5,
        useNativeDriver: true,
      }),
    ]).start();

    const sparkleLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(titleScreenSparkleOpacity, {
          toValue: 0.9,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(titleScreenSparkleOpacity, {
          toValue: 0.15,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );

    sparkleLoop.start();

    const shimmerLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(titleScreenShimmerX, {
          toValue: 240,
          duration: 1700,
          useNativeDriver: true,
        }),
        Animated.timing(titleScreenShimmerX, {
          toValue: -170,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );

    shimmerLoop.start();

    return () => {
      sparkleLoop.stop();
      shimmerLoop.stop();
    };
  }, [currentUser, titleScreenOpacity, titleScreenScale, titleScreenShimmerX, titleScreenSparkleOpacity]);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        const rawSession = await AsyncStorage.getItem(APP_SESSION_KEY);
        if (!rawSession) {
          return;
        }

        const parsed = JSON.parse(rawSession) as Partial<AppSessionState>;
        const sessionUserId = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
        if (!sessionUserId) {
          await AsyncStorage.removeItem(APP_SESSION_KEY);
          return;
        }

        const user = await loadUser(sessionUserId);
        if (!user) {
          await AsyncStorage.removeItem(APP_SESSION_KEY);
          return;
        }

        if (!isMounted) {
          return;
        }

        setCurrentUser(user);
        setShowAccount(parsed.showAccount === true);
      } catch (error) {
        console.warn('Unable to restore app session', error);
      } finally {
        if (isMounted) {
          setIsRestoringSession(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (!currentUser?.id) {
          await AsyncStorage.removeItem(APP_SESSION_KEY);
          return;
        }

        const sessionState: AppSessionState = {
          userId: currentUser.id,
          showAccount,
        };

        await AsyncStorage.setItem(APP_SESSION_KEY, JSON.stringify(sessionState));
      } catch (error) {
        console.warn('Unable to persist app session', error);
      }
    })();
  }, [currentUser?.id, showAccount]);

  useEffect(() => {
    if (!currentUser?.id) {
      setAccountReminderTimeZone(getDeviceTimeZone());
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const reminderTimeZoneSettings = await loadReminderTimeZoneSettings(currentUser.id);
        if (!cancelled) {
          setAccountReminderTimeZone(reminderTimeZoneSettings.timeZone || getDeviceTimeZone());
        }
      } catch (error) {
        console.warn('Unable to load account reminder time zone settings at app level', error);
        if (!cancelled) {
          setAccountReminderTimeZone(getDeviceTimeZone());
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) {
      setBiometricUnlockState('ready');
      return;
    }

    if (isMigratingData || isRestoringSession) {
      setBiometricUnlockState('checking');
      return;
    }

    let isMounted = true;

    (async () => {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled = await LocalAuthentication.isEnrolledAsync();

        if (!isMounted) {
          return;
        }

        if (!hasHardware || !isEnrolled) {
          setBiometricUnlockState('unsupported');
          return;
        }

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock Remind Me This with Face ID',
          fallbackLabel: 'Use passcode',
          disableDeviceFallback: false,
        });

        if (!isMounted) {
          return;
        }

        setBiometricUnlockState(result.success ? 'ready' : 'failed');
      } catch (error) {
        console.warn('Biometric unlock check failed', error);
        if (isMounted) {
          setBiometricUnlockState('failed');
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [currentUser?.id, isMigratingData, isRestoringSession]);

  useEffect(() => {
    let isMounted = true;

    const runMigration = async () => {
      if (!isApiStorageEnabled()) {
        if (isMounted) {
          setIsMigratingData(false);
        }
        return;
      }

      let apiReachable = await isApiReachable();
      if (!apiReachable) {
        // Render cold starts can exceed a single short health-check window.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        apiReachable = await isApiReachable();
      }

      if (!apiReachable) {
        if (isMounted) {
          setMigrationSummary('Cloud sync is currently unavailable. You can still sign in and continue with local storage.');
          setIsMigratingData(false);
        }
        return;
      }

      try {
        const result = await Promise.race([
          migrateLocalUsersAndEventsToApi(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('migration-timeout')), MIGRATION_TIMEOUT_MS)),
        ]);
        if (result.skipped) {
          setMigrationSummary(null);
        } else if (result.hadFailure) {
          setMigrationSummary(`Migration completed with issues: ${result.usersMigrated} user(s), ${result.eventsMigrated} event(s) imported.`);
        } else {
          setMigrationSummary(null);
        }
      } catch (error) {
        console.warn('Data migration to API storage failed', error);
        if ((error as Error)?.message === 'migration-timeout') {
          setMigrationSummary('Migration timed out. You can still sign in and continue.');
        } else {
          setMigrationSummary('Migration could not complete. You can still sign in and continue.');
        }
      } finally {
        if (isMounted) {
          setIsMigratingData(false);
        }
      }
    };

    void runMigration();

    return () => {
      isMounted = false;
    };
  }, []);

  if (showTitleScreen) {
    return (
      <SafeAreaView style={styles.titleSplashContainer}>
        <Animated.View style={styles.titleSplashBackdrop} />
        <Animated.View
          style={[
            styles.titleSplashLogoWrap,
            {
              opacity: titleScreenOpacity,
              transform: [{ scale: titleScreenScale }],
            },
          ]}
        >
          <Image source={require('./assets/icon.png')} style={styles.titleSplashLogo} resizeMode="cover" />
          <Animated.View
            style={[
              styles.titleSplashShimmer,
              {
                transform: [{ translateX: titleScreenShimmerX }, { rotate: '25deg' }],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.titleSplashSparkle,
              {
                opacity: titleScreenSparkleOpacity,
                transform: [{ translateX: -12 }, { translateY: -12 }, { rotate: '45deg' }],
              },
            ]}
          />
        </Animated.View>
        <Text style={styles.titleSplashBrand}>Remind Me This</Text>
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  if (isMigratingData || isRestoringSession) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.migrationSplash}>
          <Text style={styles.migrationSplashTitle}>{isRestoringSession ? 'Restoring your session...' : 'Preparing your account data...'}</Text>
          <Text style={styles.migrationSplashText}>{isRestoringSession ? 'Reopening your app where you left off.' : 'Running one-time migration to persistent database storage.'}</Text>
        </View>
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  if (currentUser && biometricUnlockState !== 'ready') {
    const biometricFailure = biometricUnlockState === 'failed';
    const biometricUnsupported = biometricUnlockState === 'unsupported';

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.migrationSplash}>
          <Text style={styles.migrationSplashTitle}>
            {biometricFailure ? 'Face ID not accepted' : biometricUnsupported ? 'Face ID unavailable' : 'Unlocking with Face ID...'}
          </Text>
          <Text style={styles.migrationSplashText}>
            {biometricFailure
              ? 'You can retry Face ID or continue without biometrics.'
              : biometricUnsupported
                ? 'This device does not have Face ID or it is not set up yet.'
                : 'Checking your biometric credentials before opening your account.'}
          </Text>
          <View style={styles.biometricUnlockActionsRow}>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => {
                if (biometricFailure || biometricUnsupported) {
                  setBiometricUnlockState('checking');
                }

                void (async () => {
                  try {
                    const hasHardware = await LocalAuthentication.hasHardwareAsync();
                    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

                    if (!hasHardware || !isEnrolled) {
                      setBiometricUnlockState('unsupported');
                      return;
                    }

                    const result = await LocalAuthentication.authenticateAsync({
                      promptMessage: 'Unlock Remind Me This with Face ID',
                      fallbackLabel: 'Use passcode',
                      disableDeviceFallback: false,
                    });

                    setBiometricUnlockState(result.success ? 'ready' : 'failed');
                  } catch (error) {
                    console.warn('Biometric retry failed', error);
                    setBiometricUnlockState('failed');
                  }
                })();
              }}
            >
              <Text style={styles.primaryButtonText}>{biometricFailure || biometricUnsupported ? 'Retry Face ID' : 'Continue'}</Text>
            </TouchableOpacity>
            {(biometricFailure || biometricUnsupported) ? (
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setBiometricUnlockState('ready')}
              >
                <Text style={styles.secondaryButtonText}>Continue</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  let content;

  if (!currentUser) {
    content = (
      <AuthScreen
        mode={authMode}
        onModeChange={setAuthMode}
        bootstrapNote={migrationSummary}
        onAuthenticated={async (email, userId) => {
          try {
            const user = await loadUser(userId);
            if (!user) {
              setMigrationSummary('Account loaded locally could not be refreshed from cloud. Please try again.');
              setCurrentUser(null);
              return;
            }

            setCurrentUser(user);
            setShowAccount(false);
            setAuthMode('signin');
          } catch (error) {
            console.warn('Authentication bootstrap failed', error);
            setMigrationSummary('Sign-in succeeded but app setup failed. Please try again.');
            setCurrentUser(null);
          }
        }}
      />
    );
  } else if (showAccount) {
    content = (
      <AccountScreen
        user={currentUser}
        onBack={() => setShowAccount(false)}
        onUserUpdated={(user) => setCurrentUser(user)}
        onReminderTimeZoneUpdated={setAccountReminderTimeZone}
        initialAccountAction={requestedAccountAction}
        returnToLanding={shouldReturnToLandingFromAccount}
        onInitialActionHandled={() => undefined}
        onBackToLanding={() => {
          setShouldReturnToLandingFromAccount(false);
          setRequestedAccountAction(null);
          setShowAccount(false);
        }}
        onDeleteAccount={() => {
          setShouldReturnToLandingFromAccount(false);
          setRequestedAccountAction(null);
          setCurrentUser(null);
          setShowAccount(false);
          setAuthMode('signin');
        }}
      />
    );
  } else {
    content = (
      <View style={styles.appShell}>
        <View style={styles.headerRow}>
          <View style={styles.headerBrand}>
            <Image source={require('./assets/icon.png')} style={styles.headerBrandImage} resizeMode="cover" />
            <Text style={styles.headerBrandTitle}>Remind Me This</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowAccount(true)}>
              <Text style={styles.secondaryButtonText}>Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.signOutButton}
              onPress={() => {
                setCurrentUser(null);
                setShowAccount(false);
                setAuthMode('signin');
              }}
            >
              <Text style={styles.signOutButtonText}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </View>
        <AppContent
          userId={currentUser.id}
          userEmail={currentUser.email}
          defaultReminderTimeZone={accountReminderTimeZone}
          onOpenContacts={() => {
            setRequestedAccountAction('contacts');
            setShouldReturnToLandingFromAccount(true);
            setShowAccount(true);
          }}
          onOpenCalendarSync={() => {
            setRequestedAccountAction('calendar-sync');
            setShouldReturnToLandingFromAccount(true);
            setShowAccount(true);
          }}
        />
      </View>
    );
  }

  return (
    <AppErrorBoundary>
      <SafeAreaView style={styles.container}>
        {content}
        <StatusBar style="auto" />
      </SafeAreaView>
    </AppErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f7ff',
  },
  authBackground: {
    flex: 1,
    width: '100%',
    backgroundColor: '#f5f7ff',
  },
  authContainer: {
    flex: 1,
    backgroundColor: '#f5f7ff',
    position: 'relative',
  },
  authScroll: {
    flex: 1,
    width: '100%',
  },
  authScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  glowOrb: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: '#93c5fd',
    top: '10%',
  },
  authCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  brandBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  brandBadgeText: {
    color: '#fff',
    fontSize: 22,
  },
  brandBadgeImage: {
    width: 48,
    height: 48,
    borderRadius: 12,
    marginRight: 12,
  },
  heroTextWrap: {
    flex: 1,
  },
  appName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  appTagline: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
  modePill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 14,
  },
  modePillDefault: {
    backgroundColor: '#f1f5f9',
  },
  modePillActive: {
    backgroundColor: '#dbeafe',
  },
  modePillText: {
    color: '#475569',
    fontWeight: '600',
    fontSize: 12,
  },
  modePillTextActive: {
    color: '#1d4ed8',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
  },
  subtitle: {
    color: '#64748b',
    marginBottom: 10,
  },
  userAgreementCaption: {
    color: '#64748b',
    fontSize: 12,
    marginBottom: 8,
  },
  bootstrapNote: {
    backgroundColor: '#ecfeff',
    color: '#0f766e',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    fontSize: 13,
  },
  message: {
    backgroundColor: '#eff6ff',
    color: '#1d4ed8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    fontSize: 13,
  },
  resendVerificationLinkWrap: {
    marginTop: -4,
    marginBottom: 10,
  },
  resendVerificationLinkText: {
    color: '#1d4ed8',
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  resendVerificationLinkTextDisabled: {
    color: '#93c5fd',
  },
  successToast: {
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  successToastText: {
    color: '#166534',
    fontWeight: '700',
    fontSize: 13,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 6,
    marginTop: 2,
  },
  optionalAddressLine2Input: {
    fontStyle: 'italic',
    color: '#94a3b8',
  },
  pickerWrap: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: '#f8fafc',
    shadowColor: '#94a3b8',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  picker: {
    color: '#111827',
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    backgroundColor: '#f8fafc',
    shadowColor: '#94a3b8',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  groupSearchInput: {
    marginBottom: 8,
  },
  passwordInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  passwordInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#f8fafc',
    shadowColor: '#94a3b8',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  passwordToggle: {
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
  },
  passwordToggleText: {
    fontSize: 16,
  },
  submitButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  rulesBox: {
    backgroundColor: '#f8fafc',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  ruleText: {
    fontSize: 12,
    marginBottom: 2,
  },
  ruleTextUnmet: {
    color: '#475569',
  },
  ruleTextMet: {
    color: '#15803d',
    fontWeight: '700',
  },
  signupPersonalDetailsTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 10,
  },
  linkRow: {
    marginTop: 14,
    gap: 6,
  },
  switchText: {
    color: '#2563eb',
    textAlign: 'center',
    fontWeight: '600',
  },
  secondaryLink: {
    color: '#0f766e',
    textAlign: 'center',
    fontWeight: '600',
  },
  appShell: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  headerBrand: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  headerBrandImage: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginBottom: 4,
  },
  headerBrandTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontWeight: '600',
    textAlign: 'center',
  },
  signOutButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  signOutButtonText: {
    color: '#0f172a',
    fontWeight: '600',
  },
  titleSplashContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
  titleSplashBackdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#edf6ff',
  },
  titleSplashLogoWrap: {
    width: 170,
    height: 170,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 38,
    backgroundColor: '#ffffff',
    shadowColor: '#1d4ed8',
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.35)',
  },
  titleSplashLogo: {
    width: 132,
    height: 132,
    borderRadius: 30,
  },
  titleSplashShimmer: {
    position: 'absolute',
    top: -20,
    left: -30,
    width: 64,
    height: 220,
    backgroundColor: 'rgba(255,255,255,0.82)',
    shadowColor: '#ffffff',
    shadowOpacity: 0.95,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  titleSplashSparkle: {
    position: 'absolute',
    right: 18,
    top: 18,
    width: 24,
    height: 24,
    backgroundColor: '#dbeafe',
    borderRadius: 6,
    transform: [{ rotate: '45deg' }],
    shadowColor: '#60a5fa',
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  titleSplashBrand: {
    marginTop: 18,
    fontSize: 24,
    fontWeight: '700',
    color: '#0f172a',
    letterSpacing: 0.2,
  },
  migrationSplash: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  migrationSplashTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
  },
  migrationSplashText: {
    fontSize: 14,
    color: '#475569',
    textAlign: 'center',
  },
  accountScreen: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  accountScreenContent: {
    padding: 16,
    paddingBottom: 32,
  },
  accountCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  accountHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  accountHeaderLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  accountHeaderLogo: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginRight: 12,
  },
  accountHeaderTextWrap: {
    flex: 1,
  },
  accountMainPane: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#ffffff',
  },
  settingsLinksWrap: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingBottom: 10,
    marginBottom: 10,
    gap: 10,
  },
  settingsLinkItem: {
    gap: 2,
  },
  settingsLinkButton: {
    alignSelf: 'flex-start',
  },
  settingsLinkText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  settingsLinkTextActive: {
    color: '#1d4ed8',
    fontWeight: '700',
  },
  settingsLinkDescription: {
    color: '#64748b',
    fontSize: 12,
  },
  accountDetailsColumns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    flexWrap: 'wrap',
  },
  accountDetailsPrimaryColumn: {
    flex: 1,
    minWidth: 200,
  },
  accountDetailsSecondaryColumn: {
    flex: 1,
    minWidth: 0,
    flexBasis: '50%',
  },
  accountAddressBlock: {
    marginTop: 2,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#f8fafc',
  },
  accountAddressCityStateZipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
  },
  accountNameRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
  },
  accountMobileBirthRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  accountMobileBirthColumn: {
    marginTop: 2,
  },
  accountProfileFieldStack: {
    marginTop: 2,
  },
  accountInlineField: {
    flex: 1,
    minWidth: 0,
  },
  accountCityField: {
    flex: 1,
    minWidth: 140,
  },
  accountStateField: {
    width: 76,
    minWidth: 76,
  },
  accountZipField: {
    width: 96,
    minWidth: 96,
  },
  accountCompactInput: {
    paddingVertical: 9,
    marginBottom: 8,
  },
  addressSuggestionsList: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    marginTop: -2,
    marginBottom: 8,
    overflow: 'hidden',
  },
  addressSuggestionItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  addressSuggestionMainText: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '600',
  },
  addressSuggestionSecondaryText: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  accountTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
  },
  accountSubtitle: {
    color: '#64748b',
    marginTop: 2,
  },
  contactsSyncMarker: {
    color: '#94a3b8',
    marginTop: 2,
    fontSize: 11,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 10,
    marginBottom: 8,
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  biometricUnlockActionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  primaryButtonDisabled: {
    backgroundColor: '#93c5fd',
  },
  modalActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  modalActionButton: {
    flex: 1,
    marginBottom: 0,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  passwordSection: {
    marginTop: 8,
    marginBottom: 8,
  },
  accountActionButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  accountActionButton: {
    flex: 1,
    minWidth: 160,
  },
  accountChangePasswordButton: {
    backgroundColor: '#f59e0b',
    borderColor: '#d97706',
  },
  accountChangePasswordButtonText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  contactsModalCard: {
    maxWidth: 980,
  },
  deviceContactsImportModalCard: {
    maxWidth: 560,
    maxHeight: '80%',
  },
  contactsStandalonePanel: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  contactsShell: {
    width: '100%',
    flex: 1,
    minHeight: 190,
  },
  contactsMainPane: {
    flex: 1,
    width: '100%',
    minHeight: 170,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 8,
    backgroundColor: '#ffffff',
  },
  contactsBody: {
    flex: 1,
    minHeight: 260,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  contactsLinksWrap: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingBottom: 10,
    marginBottom: 10,
    gap: 10,
  },
  contactsLinkItem: {
    gap: 2,
  },
  contactsLinkButton: {
    alignSelf: 'flex-start',
  },
  contactsLinkText: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  contactsLinkDescription: {
    color: '#64748b',
    fontSize: 12,
  },
  contactsTopActions: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  contactsTopActionButton: {
    minWidth: 64,
  },
  contactsTopActionButtonActive: {
    backgroundColor: '#bfdbfe',
  },
  contactsList: {
    width: '100%',
    flex: 1,
    minHeight: 240,
  },
  contactsListContent: {
    paddingBottom: 6,
  },
  contactsNotesInput: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  contactRowCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    backgroundColor: '#f8fafc',
  },
  contactsSummaryRow: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    backgroundColor: '#f8fafc',
  },
  groupSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  groupSummaryRowPressable: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
  },
  groupSummaryDeleteButton: {
    minWidth: 82,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactsSummaryRowText: {
    color: '#2563eb',
    fontWeight: '600',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
  groupsSummaryRowText: {
    color: '#1d4ed8',
  },
  contactsSummaryModalCard: {
    maxWidth: 560,
  },
  cloneGroupModalList: {
    maxHeight: 280,
    width: '100%',
    marginTop: 8,
    marginBottom: 12,
  },
  cloneGroupModalListContent: {
    paddingBottom: 8,
  },
  contactSummaryModalOverlay: {
    paddingTop: 110,
    paddingBottom: 50,
  },
  contactsSummaryActionButton: {
    flex: 1,
    minWidth: 0,
    marginBottom: 0,
  },
  contactsSummaryActionText: {
    color: '#0f172a',
    fontWeight: '600',
    textAlign: 'center',
    fontSize: 11,
  },
  contactSupportModalCard: {
    maxWidth: 620,
  },
  contactSupportStandalonePanel: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  contactSupportStandaloneForm: {
    width: '100%',
  },
  contactSupportStandaloneFormContent: {
    paddingBottom: 24,
  },
  contactSupportMessageInput: {
    minHeight: 150,
  },
  contactSupportErrorText: {
    color: '#b91c1c',
    marginTop: 6,
  },
  contactsSummaryDetailsCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    padding: 12,
    marginTop: 4,
  },
  groupsManageScreen: {
    flex: 1,
    width: '100%',
    minHeight: '100%',
    height: '100%',
  },
  groupsManageColumns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 4,
  },
  groupsManageColumn: {
    flex: 1,
    minWidth: 280,
  },
  groupsManagePaginationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 8,
  },
  groupsManagePageButton: {
    minWidth: 72,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupsManagePageButtonDisabled: {
    opacity: 0.45,
  },
  groupsManageAddButton: {
    marginTop: 0,
    marginBottom: 0,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  groupSummaryMemberRow: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  contactsCardActionsRow: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 8,
  },
  groupMemberHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  contactInlineActionButton: {
    flex: 1,
    minWidth: 0,
    marginBottom: 0,
  },
  contactRowName: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 14,
  },
  contactRowMeta: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
  contactsEmptyState: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 10,
  },
  contactsEmptyIcon: {
    fontSize: 52,
  },
  contactsEmptyTitle: {
    color: '#0f172a',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  contactsEmptySubtext: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
  },
  contactsGroupChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  contactsGroupChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
  },
  contactsGroupChipActive: {
    backgroundColor: '#bfdbfe',
  },
  contactsGroupChipText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 12,
  },
  passwordToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  preferenceToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  preferenceSubheading: {
    color: '#334155',
    fontWeight: '600',
    marginBottom: 2,
  },
  preferenceHelperText: {
    color: '#475569',
    marginBottom: 0,
    marginLeft: 8,
  },
  defaultReminderTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  clockIntervalOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  clockIntervalOption: {
    marginBottom: 0,
  },
  pickerWrapper: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
  },
  timeRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  defaultReminderTimeChangeButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  deliveryPrimaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  deliveryOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  deliveryOption: {
    marginRight: 12,
  },
  deliveryVerificationHint: {
    color: '#475569',
    fontSize: 12,
    marginBottom: 8,
  },
  deviceInstructionLinkRow: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  deviceInstructionLinkText: {
    color: '#2563eb',
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  preferenceToggleText: {
    color: '#0f172a',
    fontWeight: '600',
  },
  preferenceToggleDisabled: {
    opacity: 0.45,
  },
  preferenceToggleDisabledText: {
    color: '#64748b',
    fontWeight: '600',
  },
  passwordCheckbox: {
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 4,
    marginRight: 8,
    backgroundColor: '#fff',
  },
  passwordCheckboxDisabled: {
    backgroundColor: '#f1f5f9',
  },
  passwordCheckboxChecked: {
    width: 10,
    height: 10,
    margin: 2,
    borderRadius: 2,
    backgroundColor: '#0f172a',
  },
  authAgreementBlock: {
    marginBottom: 14,
  },
  signupSmsConsentBlock: {
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#f8fafc',
  },
  signupSmsConsentHint: {
    color: '#475569',
    fontSize: 12,
    marginTop: 4,
  },
  signupSmsConsentActions: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  signupSmsConsentButton: {
    minWidth: 56,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#94a3b8',
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
  },
  signupSmsConsentButtonSelected: {
    backgroundColor: '#bfdbfe',
    borderColor: '#3b82f6',
  },
  signupSmsConsentButtonText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  signupSmsConsentButtonTextSelected: {
    color: '#1d4ed8',
  },
  authAgreementRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  authAgreementText: {
    flex: 1,
    color: '#0f172a',
    fontSize: 13,
    lineHeight: 18,
  },
  authAgreementLink: {
    color: '#2563eb',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 24,
    textDecorationLine: 'underline',
  },
  authAgreementLinkDisabled: {
    color: '#94a3b8',
    textDecorationLine: 'none',
  },
  radioOuter: {
    width: 16,
    height: 16,
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0f172a',
  },
  calendarSyncCard: {
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 10,
    marginTop: 6,
    backgroundColor: '#f8fafc',
  },
  calendarSyncHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  calendarSyncStatusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  calendarSyncStatusSynched: {
    backgroundColor: '#dcfce7',
  },
  calendarSyncStatusPaused: {
    backgroundColor: '#fef3c7',
  },
  calendarSyncStatusNotSynched: {
    backgroundColor: '#e2e8f0',
  },
  calendarSyncStatusText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 12,
  },
  calendarSyncRowsWrap: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  calendarSyncRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  calendarSyncRowLast: {
    borderBottomWidth: 0,
  },
  calendarSyncHeaderInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  calendarSyncAutoToggle: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 3,
  },
  calendarSyncAutoToggleEnabled: {
    backgroundColor: '#dcfce7',
  },
  calendarSyncAutoToggleDisabled: {
    backgroundColor: '#fee2e2',
  },
  calendarSyncAutoToggleText: {
    fontSize: 10,
    fontWeight: '600',
  },
  calendarSyncAutoToggleTextEnabled: {
    color: '#15803d',
  },
  calendarSyncAutoToggleTextDisabled: {
    color: '#b91c1c',
  },
  calendarSyncProviderColumn: {
    marginBottom: 6,
  },
  calendarSyncProviderLabel: {
    color: '#0f172a',
    fontWeight: '600',
    fontSize: 13,
  },
  calendarSyncProviderSubtext: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  calendarSyncDetailsColumn: {
  },
  calendarSyncStatusColumn: {
    color: '#334155',
    fontWeight: '500',
    fontSize: 12,
    marginBottom: 4,
  },
  calendarSyncStatusConnectedText: {
    color: '#15803d',
  },
  calendarSyncStatusPausedText: {
    color: '#2563eb',
  },
  calendarSyncStatusNotConnectedText: {
    color: '#dc2626',
  },
  calendarSyncRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  calendarSyncActionTextButton: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 7,
    backgroundColor: '#e2e8f0',
  },
  calendarSyncActionText: {
    color: '#0f172a',
    fontWeight: '600',
    fontSize: 12,
  },
  calendarSyncActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  calendarSyncActionButton: {
    minWidth: 110,
    marginTop: 0,
    marginBottom: 0,
    paddingHorizontal: 12,
  },
  syncPushButton: {
    marginTop: 8,
    marginBottom: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  googleSyncInlineButton: {
    marginTop: 6,
    marginBottom: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  calendarSyncPrimaryButtonText: {
    fontSize: 12,
  },
  modalOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 10,
  },
  deleteModalOverlay: {
    paddingTop: 120,
    paddingBottom: 40,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#0f172a',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  fullScreenModalOverlay: {
    padding: 0,
  },
  fullScreenModalCard: {
    width: '100%',
    maxWidth: undefined,
    height: '100%',
    borderRadius: 0,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 28,
  },
  defaultReminderModalCard: {
    maxWidth: 220,
    padding: 12,
  },
  timeZoneModalOverlay: {
    padding: 0,
    justifyContent: 'flex-end',
  },
  timeZoneModalCard: {
    width: '100%',
    maxWidth: undefined,
    height: '50%',
    minHeight: 340,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
    paddingTop: 10,
    paddingBottom: 20,
    paddingHorizontal: 20,
  },
  timeZoneSheetHandle: {
    width: 78,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#94a3b8',
    alignSelf: 'center',
    marginBottom: 12,
  },
  timeZonePickerWrapper: {
    flex: 1,
    marginBottom: 10,
    backgroundColor: '#ffffff',
  },
  timeZonePicker: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  timeZoneModalActionsRow: {
    marginTop: 0,
    marginBottom: 0,
    backgroundColor: '#ffffff',
  },
  timeZoneModalActionText: {
    textAlign: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 12,
  },
  deleteHint: {
    color: '#64748b',
    marginBottom: 10,
  },
  deleteButton: {
    backgroundColor: '#dc2626',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  deleteButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
});
