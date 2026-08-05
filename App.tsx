import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Alert,
  Animated,
  Image,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as Calendar from 'expo-calendar';
import AppContent from './src/AppContent';
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
  signInUser,
  StoredUser,
  updateUserProfile,
  validateBirthDate,
  validateEmail,
  validatePassword,
  validatePhoneNumber,
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

const formatPhoneNumberInput = (value: string) => {
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

const formatReminderTimeLabel = (hour: number, minute: number) => {
  const normalizedHour = Math.max(0, Math.min(23, Math.trunc(hour)));
  const normalizedMinute = Math.max(0, Math.min(59, Math.trunc(minute)));
  const period = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour}:${String(normalizedMinute).padStart(2, '0')} ${period}`;
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
      ? 'Enter email and use as login ID'
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

    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ]),
      { iterations: -1 },
    ).start();

    Animated.timing(cardTranslateX, { toValue: 0, duration: 1, useNativeDriver: true }).start();

    return () => {
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

      if (!streetAddress.trim()) {
        setMessage('Please enter your street address.');
        return;
      }

      if (!city.trim()) {
        setMessage('Please enter your city.');
        return;
      }

      if (!state) {
        setMessage('Please select your state.');
        return;
      }

      if (!zipCode.trim()) {
        setMessage('Please enter your ZIP code.');
        return;
      }

      const birthDateError = validateBirthDate(birthDate);
      if (birthDateError) {
        setMessage(birthDateError);
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

      if (password !== confirmPassword) {
        setMessage('Passwords do not match. Please confirm your password.');
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
      const address = [streetAddress.trim(), addressLine2.trim(), `${city.trim()}, ${state} ${zipCode.trim()}`]
        .filter(Boolean)
        .join('\n');

      setIsSubmitting(true);
      const result = await createUser(email.trim().toLowerCase(), password, mobileNumber.trim(), fullName, address, birthDate.trim());
      setIsSubmitting(false);

      if (result.error) {
        setMessage(result.error);
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
        return;
      }

      setMessage('We could not find an account with those details.');
      return;
    }

    onAuthenticated(signInResult.user.email, signInResult.user.id);
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

          {mode === 'signup' ? null : (
            <View style={[styles.modePill, mode === 'signup' ? styles.modePillActive : styles.modePillDefault]}>
              <Text style={[styles.modePillText, mode === 'signup' ? styles.modePillTextActive : null]}>
                {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
              </Text>
            </View>
          )}

          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          {bootstrapNote ? <Text style={styles.bootstrapNote}>{bootstrapNote}</Text> : null}

          {message ? <Text style={styles.message}>{message}</Text> : null}

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
                    autoCapitalize="words"
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
                    autoCapitalize="words"
                  />
                </View>
              </View>

              <View style={styles.accountAddressBlock}>
                <Text style={styles.fieldLabel}>Address</Text>
                <TextInput
                  style={[styles.input, styles.accountCompactInput]}
                  placeholder="Street address"
                  value={streetAddress}
                  onFocus={() => setIsSignupAddressFocused(true)}
                  onBlur={() => {
                    signupAddressBlurTimeoutRef.current = setTimeout(() => {
                      if (isSelectingSignupAddressPredictionRef.current) {
                        isSelectingSignupAddressPredictionRef.current = false;
                        return;
                      }
                      setIsSignupAddressFocused(false);
                      setSignupAddressPredictions([]);
                    }, 120);
                  }}
                  onChangeText={(value) => {
                    setStreetAddress(value);
                    if (message) {
                      setMessage(null);
                    }
                  }}
                  autoCapitalize="words"
                />

                {isSignupAddressFocused && signupAddressPredictions.length ? (
                  <View style={styles.addressSuggestionsList}>
                    {signupAddressPredictions.map((prediction) => (
                      <TouchableOpacity
                        key={prediction.placeId}
                        style={styles.addressSuggestionItem}
                        onPressIn={() => {
                          isSelectingSignupAddressPredictionRef.current = true;
                          if (signupAddressBlurTimeoutRef.current) {
                            clearTimeout(signupAddressBlurTimeoutRef.current);
                          }
                        }}
                        onPress={() => void applySignupAddressPrediction(prediction)}
                      >
                        <Text style={styles.addressSuggestionMainText} numberOfLines={1}>{prediction.mainText}</Text>
                        {prediction.secondaryText ? <Text style={styles.addressSuggestionSecondaryText} numberOfLines={1}>{prediction.secondaryText}</Text> : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}

                <TextInput
                  style={[styles.input, styles.accountCompactInput, !addressLine2.trim() && styles.optionalAddressLine2Input]}
                  placeholder="Address line 2"
                  placeholderTextColor="#94a3b8"
                  value={addressLine2}
                  onChangeText={(value) => {
                    setAddressLine2(value);
                    if (message) {
                      setMessage(null);
                    }
                  }}
                  autoCapitalize="words"
                />

                <TextInput
                  style={[styles.input, styles.accountCompactInput]}
                  placeholder="City"
                  value={city}
                  onChangeText={(value) => {
                    setCity(value);
                    if (message) {
                      setMessage(null);
                    }
                  }}
                  autoCapitalize="words"
                />

                <View style={styles.accountAddressCityStateZipRow}>
                  <View style={[styles.accountInlineField, styles.accountStateField]}>
                    <View style={[styles.pickerWrap, styles.accountCompactInput]}>
                      <Picker
                        selectedValue={state}
                        onValueChange={(value) => {
                          setState(value);
                          if (message) {
                            setMessage(null);
                          }
                        }}
                        style={styles.picker}
                      >
                        <Picker.Item label="State" value="" />
                        <Picker.Item label="Alabama" value="AL" />
                        <Picker.Item label="Alaska" value="AK" />
                        <Picker.Item label="Arizona" value="AZ" />
                        <Picker.Item label="Arkansas" value="AR" />
                        <Picker.Item label="California" value="CA" />
                        <Picker.Item label="Colorado" value="CO" />
                        <Picker.Item label="Connecticut" value="CT" />
                        <Picker.Item label="Delaware" value="DE" />
                        <Picker.Item label="Florida" value="FL" />
                        <Picker.Item label="Georgia" value="GA" />
                        <Picker.Item label="Hawaii" value="HI" />
                        <Picker.Item label="Idaho" value="ID" />
                        <Picker.Item label="Illinois" value="IL" />
                        <Picker.Item label="Indiana" value="IN" />
                        <Picker.Item label="Iowa" value="IA" />
                        <Picker.Item label="Kansas" value="KS" />
                        <Picker.Item label="Kentucky" value="KY" />
                        <Picker.Item label="Louisiana" value="LA" />
                        <Picker.Item label="Maine" value="ME" />
                        <Picker.Item label="Maryland" value="MD" />
                        <Picker.Item label="Massachusetts" value="MA" />
                        <Picker.Item label="Michigan" value="MI" />
                        <Picker.Item label="Minnesota" value="MN" />
                        <Picker.Item label="Mississippi" value="MS" />
                        <Picker.Item label="Missouri" value="MO" />
                        <Picker.Item label="Montana" value="MT" />
                        <Picker.Item label="Nebraska" value="NE" />
                        <Picker.Item label="Nevada" value="NV" />
                        <Picker.Item label="New Hampshire" value="NH" />
                        <Picker.Item label="New Jersey" value="NJ" />
                        <Picker.Item label="New Mexico" value="NM" />
                        <Picker.Item label="New York" value="NY" />
                        <Picker.Item label="North Carolina" value="NC" />
                        <Picker.Item label="North Dakota" value="ND" />
                        <Picker.Item label="Ohio" value="OH" />
                        <Picker.Item label="Oklahoma" value="OK" />
                        <Picker.Item label="Oregon" value="OR" />
                        <Picker.Item label="Pennsylvania" value="PA" />
                        <Picker.Item label="Rhode Island" value="RI" />
                        <Picker.Item label="South Carolina" value="SC" />
                        <Picker.Item label="South Dakota" value="SD" />
                        <Picker.Item label="Tennessee" value="TN" />
                        <Picker.Item label="Texas" value="TX" />
                        <Picker.Item label="Utah" value="UT" />
                        <Picker.Item label="Vermont" value="VT" />
                        <Picker.Item label="Virginia" value="VA" />
                        <Picker.Item label="Washington" value="WA" />
                        <Picker.Item label="West Virginia" value="WV" />
                        <Picker.Item label="Wisconsin" value="WI" />
                        <Picker.Item label="Wyoming" value="WY" />
                      </Picker>
                    </View>
                  </View>

                  <View style={[styles.accountInlineField, styles.accountZipField]}>
                    <TextInput
                      style={[styles.input, styles.accountCompactInput]}
                      placeholder="ZIP"
                      value={zipCode}
                      onChangeText={(value) => {
                        setZipCode(value.replace(/\D/g, '').slice(0, 5));
                        if (message) {
                          setMessage(null);
                        }
                      }}
                      keyboardType="number-pad"
                      maxLength={5}
                    />
                  </View>
                </View>
              </View>

              <View style={styles.accountMobileBirthRow}>
                <View style={styles.accountInlineField}>
                  <Text style={styles.fieldLabel}>Mobile phone</Text>
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
}

type ContactsView = 'contacts' | 'favorites' | 'deleted' | 'groups';
type ContactsDisplayMode = 'detail' | 'summary';
type GroupsDisplayMode = 'new' | 'summary' | 'detail';
type AccountAction = 'profile' | 'settings' | 'calendar-sync';

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

const getContactsStorageKey = (userId: string) => `special-date-contacts:${userId}`;

function AccountScreen({ user, onBack, onUserUpdated, onDeleteAccount, onReminderTimeZoneUpdated }: AccountScreenProps) {
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
  const [defaultReminderHour, setDefaultReminderHour] = useState(9);
  const [defaultReminderMinute, setDefaultReminderMinute] = useState(0);
  const [defaultReminderDraftHour, setDefaultReminderDraftHour] = useState(9);
  const [defaultReminderDraftMinute, setDefaultReminderDraftMinute] = useState(0);
  const [isSavingDefaultReminderTime, setIsSavingDefaultReminderTime] = useState(false);
  const [defaultReminderTimeZone, setDefaultReminderTimeZone] = useState(getDeviceTimeZone());
  const [defaultReminderTimeZoneDraft, setDefaultReminderTimeZoneDraft] = useState(getDeviceTimeZone());
  const [isSavingReminderTimeZone, setIsSavingReminderTimeZone] = useState(false);
  const [calendarSyncProviderDraft, setCalendarSyncProviderDraft] = useState<CalendarSyncProvider>('none');
  const [googleCalendarPermission, setGoogleCalendarPermission] = useState<CalendarSyncPermission>('write');
  const [googleCalendarId, setGoogleCalendarId] = useState('');
  const [isGoogleConnected, setIsGoogleConnected] = useState(false);
  const [isGoogleSyncPaused, setIsGoogleSyncPaused] = useState(false);
  const [googleCalendarIdDraft, setGoogleCalendarIdDraft] = useState('');
  const [outlookCalendarEmail, setOutlookCalendarEmail] = useState('');
  const [outlookCalendarEmailDraft, setOutlookCalendarEmailDraft] = useState('');
  const [isOutlookConnected, setIsOutlookConnected] = useState(false);
  const [isOutlookSyncPaused, setIsOutlookSyncPaused] = useState(false);
  const [appleCalendarId, setAppleCalendarId] = useState('');
  const [appleCalendarName, setAppleCalendarName] = useState('');
  const [appleCalendarNameDraft, setAppleCalendarNameDraft] = useState('');
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
  const [activeContactsView, setActiveContactsView] = useState<ContactsView>('contacts');
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
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedGroupDescriptionDraft, setSelectedGroupDescriptionDraft] = useState('');
  const [groupsDisplayMode, setGroupsDisplayMode] = useState<GroupsDisplayMode>('summary');
  const [activeSummaryGroupId, setActiveSummaryGroupId] = useState<string | null>(null);
  const [selectedContactIdToAdd, setSelectedContactIdToAdd] = useState('');
  const [showContactSupportModal, setShowContactSupportModal] = useState(false);
  const [contactSupportSubject, setContactSupportSubject] = useState('');
  const [contactSupportMessage, setContactSupportMessage] = useState('');
  const [contactSupportError, setContactSupportError] = useState<string | null>(null);
  const [isSendingContactSupport, setIsSendingContactSupport] = useState(false);
  const [deliveryDevice, setDeliveryDevice] = useState(true);
  const [deliveryEmail, setDeliveryEmail] = useState(false);
  const [activeAccountAction, setActiveAccountAction] = useState<AccountAction>('profile');
  const activeContacts = useMemo(() => contacts.filter((entry) => !entry.deletedAt), [contacts]);
  const favoriteContacts = useMemo(() => activeContacts.filter((entry) => entry.isFavorite), [activeContacts]);
  const deletedContacts = useMemo(() => contacts.filter((entry) => Boolean(entry.deletedAt)), [contacts]);
  const visibleContacts = useMemo(() => {
    if (activeContactsView === 'favorites') {
      return favoriteContacts;
    }
    if (activeContactsView === 'deleted') {
      return deletedContacts;
    }
    return activeContacts;
  }, [activeContacts, activeContactsView, deletedContacts, favoriteContacts]);
  const activeSummaryContact = useMemo(
    () => contacts.find((entry) => entry.id === activeSummaryContactId) || null,
    [activeSummaryContactId, contacts],
  );
  const selectedGroup = useMemo(() => contactGroups.find((entry) => entry.id === selectedGroupId) || null, [contactGroups, selectedGroupId]);
  const activeSummaryGroup = useMemo(() => contactGroups.find((entry) => entry.id === activeSummaryGroupId) || null, [activeSummaryGroupId, contactGroups]);
  const getGroupMemberCount = useCallback((group: ContactGroup) => (
    group.contactIds.filter((contactId) => activeContacts.some((entry) => entry.id === contactId)).length
  ), [activeContacts]);
  const activeSummaryGroupMembers = useMemo(() => {
    if (!activeSummaryGroup) {
      return [] as AccountContact[];
    }

    return activeSummaryGroup.contactIds
      .map((contactId) => activeContacts.find((entry) => entry.id === contactId) || null)
      .filter((entry): entry is AccountContact => entry !== null);
  }, [activeSummaryGroup, activeContacts]);
  const selectedGroupMembers = useMemo(() => {
    if (!selectedGroup) {
      return [] as AccountContact[];
    }

    return selectedGroup.contactIds
      .map((contactId) => activeContacts.find((entry) => entry.id === contactId) || null)
      .filter((entry): entry is AccountContact => entry !== null);
  }, [activeContacts, selectedGroup]);
  const contactsAvailableForSelectedGroup = useMemo(() => {
    if (!selectedGroup) {
      return [] as AccountContact[];
    }

    return activeContacts.filter((entry) => !selectedGroup.contactIds.includes(entry.id));
  }, [activeContacts, selectedGroup]);

  useEffect(() => {
    setSelectedGroupDescriptionDraft(selectedGroup?.description || '');
  }, [selectedGroup?.description, selectedGroup?.id]);

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

      const selectedCalendar = await Calendar.getCalendarAsync(appleCalendarId);
      if (!selectedCalendar) {
        await clearAppleCalendarAssociation();
        return;
      }

      if (selectedCalendar.title && selectedCalendar.title !== appleCalendarName) {
        setAppleCalendarName(selectedCalendar.title);
        setAppleCalendarNameDraft(selectedCalendar.title);
      }

      setIsAppleConnected(true);
    } catch {
      setIsAppleConnected(false);
    }
  }, [appleCalendarId, appleCalendarName, isAppleConfigured, isAppleLocalSyncSupported, user.id]);

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
      } catch (error) {
        console.warn('Unable to load account reminder delivery settings', error);
        setDeliveryDevice(true);
        setDeliveryEmail(false);
      }

      try {
        const reminderTime = await loadReminderDefaultTimeSettings(user.id);
        setDefaultReminderHour(reminderTime.hour);
        setDefaultReminderMinute(reminderTime.minute);
        setDefaultReminderDraftHour(reminderTime.hour);
        setDefaultReminderDraftMinute(reminderTime.minute);
      } catch (error) {
        console.warn('Unable to load account default reminder time settings', error);
        setDefaultReminderHour(9);
        setDefaultReminderMinute(0);
        setDefaultReminderDraftHour(9);
        setDefaultReminderDraftMinute(0);
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
        setOutlookCalendarEmail(calendarSyncSettings.outlook.email || '');
        setOutlookCalendarEmailDraft(calendarSyncSettings.outlook.email || '');
        setIsOutlookSyncPaused(calendarSyncSettings.outlook.syncPaused === true);
        setAppleCalendarId(calendarSyncSettings.apple.appleId || '');
        setAppleCalendarName(calendarSyncSettings.apple.calendarName || '');
        setAppleCalendarNameDraft(calendarSyncSettings.apple.calendarName || '');
        setIsAppleSyncPaused(calendarSyncSettings.apple.syncPaused === true);
      } catch (error) {
        console.warn('Unable to load account calendar sync settings', error);
        setCalendarSyncProviderDraft('none');
        setIsGoogleSyncPaused(false);
        setOutlookCalendarEmail('');
        setOutlookCalendarEmailDraft('');
        setIsOutlookSyncPaused(false);
        setAppleCalendarId('');
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
      setAppleCalendarNameDraft(appleCalendarName);
    } else {
      setGoogleCalendarIdDraft(googleCalendarId);
    }
    setShowCalendarSyncEditor(true);
  };

  const buildCalendarSyncSettings = (overrides?: {
    google?: Partial<{ calendarId: string; permission: CalendarSyncPermission; syncPaused: boolean }>;
    outlook?: Partial<{ email: string; syncPaused: boolean }>;
    apple?: Partial<{ appleId: string; calendarName: string; syncPaused: boolean }>;
  }) => ({
    provider: 'none' as CalendarSyncProvider,
    google: {
      calendarId: overrides?.google?.calendarId ?? googleCalendarId,
      permission: overrides?.google?.permission ?? 'write',
      syncPaused: overrides?.google?.syncPaused ?? isGoogleSyncPaused,
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
  }, [buildCalendarSyncSettings, user.id]);

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
        apple: {
          appleId: '',
          calendarName: '',
          syncPaused: false,
        },
      }), user.id);
    } catch (error) {
      console.warn('Unable to clear Apple calendar association', error);
    }

    setAppleCalendarId('');
    setAppleCalendarName('');
    setAppleCalendarNameDraft('');
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
    if (typeof window === 'undefined') {
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

  const startAppleConnection = async (calendarName: string, saveAsConfigured: boolean) => {
    const normalizedCalendarName = calendarName.trim();

    if (!isAppleLocalSyncSupported) {
      setMessage(`Apple iCalendar sync is only available on iOS devices. Current platform: ${Platform.OS}.`);
      return;
    }

    setIsConnectingApple(true);
    try {
      const permission = await Calendar.requestCalendarPermissionsAsync();
      if (permission.status !== 'granted') {
        setMessage('Calendar permission is required to connect Apple sync on iOS.');
        return;
      }

      const eventCalendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const writableCalendars = eventCalendars.filter((entry) => entry.allowsModifications !== false);
      const preferredName = normalizedCalendarName.toLowerCase();
      const matchedCalendar = preferredName
        ? writableCalendars.find((entry) => entry.title.toLowerCase() === preferredName)
          || writableCalendars.find((entry) => entry.title.toLowerCase().includes(preferredName))
        : undefined;

      let selectedCalendar = matchedCalendar;
      if (!selectedCalendar) {
        try {
          selectedCalendar = await Calendar.getDefaultCalendarAsync();
        } catch {
          selectedCalendar = undefined;
        }
      }

      if (!selectedCalendar) {
        selectedCalendar = writableCalendars[0];
      }

      if (!selectedCalendar) {
        setMessage('No writable iOS calendar was found on this device.');
        return;
      }

      if (saveAsConfigured) {
        await saveCalendarSyncSettings(buildCalendarSyncSettings({
          apple: {
            appleId: selectedCalendar.id,
            calendarName: selectedCalendar.title,
            syncPaused: false,
          },
        }), user.id);

        setCalendarSyncProviderDraft('apple');
        setAppleCalendarId(selectedCalendar.id);
        setAppleCalendarName(selectedCalendar.title);
        setAppleCalendarNameDraft(selectedCalendar.title);
        setIsAppleSyncPaused(false);
      }
      setIsAppleConnected(true);
      setShowCalendarSyncEditor(false);
      setMessage(`Apple Calendar connected on this device (${selectedCalendar.title}).`);
    } catch (error) {
      console.warn('Apple connection failed', error);
      setMessage('Unable to connect Apple Calendar right now.');
    } finally {
      setIsConnectingApple(false);
    }
  };

  const handleConnectApple = async () => {
    await startAppleConnection(appleCalendarNameDraft, true);
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
      await saveCalendarSyncSettings(buildCalendarSyncSettings({
        apple: {
          appleId: '',
          calendarName: '',
          syncPaused: false,
        },
      }), user.id);

      setCalendarSyncProviderDraft('none');
      setAppleCalendarId('');
      setAppleCalendarName('');
      setAppleCalendarNameDraft('');
      setIsAppleConnected(false);
      setIsAppleSyncPaused(false);
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
          title: event.title,
          notes: event.notes || '',
          location: event.people || '',
          startDate,
          endDate,
          allDay: isAllDay,
          url: `${markerPrefix}${specialDateId}`,
          recurrenceRule: recurrenceFrequency ? { frequency: recurrenceFrequency } : undefined,
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

  const handleDeliveryToggle = async (type: 'device' | 'email') => {
    const nextDevice = type === 'device' ? !deliveryDevice : deliveryDevice;
    const nextEmail = type === 'email' ? !deliveryEmail : deliveryEmail;

    setDeliveryDevice(nextDevice);
    setDeliveryEmail(nextEmail);

    try {
      await saveReminderDeliverySettings({
        device: nextDevice,
        email: nextEmail,
        text: false,
      }, user.id);
    } catch (error) {
      console.warn('Unable to save account reminder delivery settings', error);
      setDeliveryDevice(deliveryDevice);
      setDeliveryEmail(deliveryEmail);
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

  const handleSaveDefaultReminderTime = async () => {
    setIsSavingDefaultReminderTime(true);

    try {
      await saveReminderDefaultTimeSettings({
        hour: defaultReminderDraftHour,
        minute: defaultReminderDraftMinute,
      }, user.id);
      setDefaultReminderHour(defaultReminderDraftHour);
      setDefaultReminderMinute(defaultReminderDraftMinute);
      setShowDefaultReminderTimeEditor(false);
      setMessage('Default reminder time updated.');
    } catch (error) {
      console.warn('Unable to save account default reminder time settings', error);
      setMessage('Unable to update default reminder time right now.');
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
    if (!deliveryDevice && !deliveryEmail) {
      setMessage('Please choose a delivery type before saving your details.');
      return;
    }

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

    if (!addressLine1.trim()) {
      setMessage('Please enter address line 1.');
      return;
    }

    if (!addressCity.trim()) {
      setMessage('Please enter a city on address line 3.');
      return;
    }

    if (!addressState.trim()) {
      setMessage('Please enter a state on address line 4.');
      return;
    }

    if (!addressZip.trim()) {
      setMessage('Please enter a ZIP code on address line 4.');
      return;
    }

    const composedAddress = composeAddressParts({
      line1: addressLine1,
      line2: addressLine2,
      city: addressCity,
      state: addressState,
      zip: addressZip,
    });

    try {
      setIsSaving(true);
      const result = await updateUserProfile(user.id, {
        mobileNumber: mobileNumber.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`.trim(),
        address: composedAddress,
        birthDate: birthDate.trim(),
      });
      setIsSaving(false);

      if (result.error) {
        setMessage(result.error);
        return;
      }

      onUserUpdated(result.user!);
      setMessage('Profile updated successfully.');
    } catch (error) {
      setIsSaving(false);
      setMessage('Unable to save profile right now.');
    }
  };

  const handleBack = () => {
    if (!deliveryDevice && !deliveryEmail) {
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
          const fallbackName = splitNameParts(String((candidate as { fullName?: string }).fullName || ''));
          const firstName = String(candidate.firstName || fallbackName.firstName).trim();
          const lastName = String(candidate.lastName || fallbackName.lastName).trim();

          if (!id || !email || !firstName) {
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
            mobileNumber: candidate.mobileNumber ? String(candidate.mobileNumber).trim() : '',
            company: candidate.company ? String(candidate.company).trim() : '',
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
    };

    await AsyncStorage.setItem(getContactsStorageKey(user.id), JSON.stringify(payload));
    setContacts(nextContacts);
    setContactGroups(nextGroups);
  }, [user.id]);

  const loadContacts = useCallback(async () => {
    setIsLoadingContacts(true);
    try {
      const rawContacts = await AsyncStorage.getItem(getContactsStorageKey(user.id));
      const snapshot = normalizeContactsSnapshot(rawContacts);
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
  }, [user.id]);

  const resetContactEditor = () => {
    setContactDraft(createEmptyContactDraft());
    setContactAddressLine1('');
    setContactAddressLine2('');
    setContactAddressCity('');
    setContactAddressState('');
    setContactAddressZip('');
    setContactAddressPredictions([]);
    setActiveSummaryGroupId(null);
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
    setActiveSummaryGroupId(null);
    setEditingContactId(null);
    setActiveSummaryContactId(null);
    setIsEditingContact(true);
  };

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
    const normalizedCompany = contactDraft.company.trim();
    const normalizedNotes = contactDraft.notes.trim();

    if (!validateEmail(normalizedEmail)) {
      setContactsMessage('Enter a valid contact email address.');
      return;
    }

    if (!normalizedFirstName) {
      setContactsMessage('Enter a contact first name.');
      return;
    }

    if (!normalizedLastName) {
      setContactsMessage('Enter a contact last name.');
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
      entry.email.toLowerCase() === normalizedEmail
      && entry.id !== editingContactId
      && !entry.deletedAt
    ));

    if (duplicate) {
      setContactsMessage('A contact with this email already exists.');
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
            id: crypto.randomUUID(),
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

  const softDeleteContact = async (contactId: string) => {
    const deletionStamp = new Date().toISOString();
    const nextContacts = contacts.map((entry) => (
      entry.id === contactId
        ? {
            ...entry,
            deletedAt: deletionStamp,
            isFavorite: false,
            groupIds: [],
            updatedAt: deletionStamp,
          }
        : entry
    ));
    const nextGroups = contactGroups.map((group) => ({
      ...group,
      contactIds: group.contactIds.filter((id) => id !== contactId),
    }));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setContactsMessage('Contact moved to Deleted.');
  };

  const restoreDeletedContact = async (contactId: string) => {
    const nextContacts = contacts.map((entry) => (
      entry.id === contactId
        ? {
            ...entry,
            deletedAt: null,
            updatedAt: new Date().toISOString(),
          }
        : entry
    ));

    await persistContactsSnapshot(nextContacts, contactGroups);
    setContactsMessage('Contact restored.');
  };

  const permanentlyDeleteContact = async (contactId: string) => {
    const nextContacts = contacts.filter((entry) => entry.id !== contactId);
    const nextGroups = contactGroups.map((group) => ({
      ...group,
      contactIds: group.contactIds.filter((id) => id !== contactId),
    }));

    await persistContactsSnapshot(nextContacts, nextGroups);
    setContactsMessage('Contact permanently deleted.');
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
      id: crypto.randomUUID(),
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
    setGroupsDisplayMode('detail');
    setContactsMessage('Group created.');
  };

  const addSelectedContactToSelectedGroup = async () => {
    if (!selectedGroup || !selectedContactIdToAdd) {
      setContactsMessage('Select a group and contact first.');
      return;
    }

    const nextGroups = contactGroups.map((group) => (
      group.id === selectedGroup.id
        ? {
            ...group,
            contactIds: group.contactIds.includes(selectedContactIdToAdd)
              ? group.contactIds
              : [...group.contactIds, selectedContactIdToAdd],
          }
        : group
    ));

    const nextContacts = contacts.map((entry) => (
      entry.id === selectedContactIdToAdd
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
    setContactsMessage('Group description updated.');
  };

  const handleOpenContacts = async () => {
    await loadContacts();
    setActiveContactsView('contacts');
    setGroupsDisplayMode('summary');
    setNewGroupName('');
    setNewGroupDescription('');
    setSelectedGroupId('');
    setActiveSummaryGroupId(null);
    setContactsMessage(null);
    resetContactEditor();
    setShowContactsModal(true);
  };

  const handleConfirmDelete = async () => {

    try {
      setIsSaving(true);
      const result = await deleteUser(user.id);
      setIsSaving(false);

      if (result.error) {
        setMessage(result.error);
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

      {showDefaultReminderTimeEditor ? (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.defaultReminderModalCard]}>
            <Text style={styles.modalTitle}>Reminder time</Text>
            <View style={styles.timeRow}>
              <View style={styles.pickerWrapper}>
                <Picker
                  selectedValue={defaultReminderDraftHour % 12 || 12}
                  onValueChange={(value) => {
                    const hourValue = Number(value);
                    const currentHours = defaultReminderDraftHour;
                    const adjustedHours = (hourValue % 12) + (currentHours >= 12 ? 12 : 0);
                    setDefaultReminderDraftHour(adjustedHours);
                  }}
                  style={styles.picker}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((hour) => (
                    <Picker.Item key={hour} label={hour.toString()} value={hour} />
                  ))}
                </Picker>
              </View>
              <View style={styles.pickerWrapper}>
                <Picker
                  selectedValue={defaultReminderDraftMinute}
                  onValueChange={(value) => setDefaultReminderDraftMinute(Number(value))}
                  style={styles.picker}
                >
                  {Array.from({ length: 60 }, (_, index) => index).map((minute) => (
                    <Picker.Item key={minute} label={minute.toString().padStart(2, '0')} value={minute} />
                  ))}
                </Picker>
              </View>
              <View style={styles.pickerWrapper}>
                <Picker
                  selectedValue={defaultReminderDraftHour >= 12 ? 'PM' : 'AM'}
                  onValueChange={(value) => {
                    const isPm = value === 'PM';
                    const currentHour = defaultReminderDraftHour % 12;
                    setDefaultReminderDraftHour(isPm ? currentHour + 12 : currentHour);
                  }}
                  style={styles.picker}
                >
                  <Picker.Item label="AM" value="AM" />
                  <Picker.Item label="PM" value="PM" />
                </Picker>
              </View>
            </View>

            <View style={styles.modalActionsRow}>
              <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={() => void handleSaveDefaultReminderTime()} disabled={isSavingDefaultReminderTime}>
                <Text style={styles.primaryButtonText}>{isSavingDefaultReminderTime ? 'Saving…' : 'Save Time'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setDefaultReminderDraftHour(defaultReminderHour);
                  setDefaultReminderDraftMinute(defaultReminderMinute);
                  setShowDefaultReminderTimeEditor(false);
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {showReminderTimeZoneEditor ? (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.defaultReminderModalCard]}>
            <Text style={styles.modalTitle}>Reminder time zone</Text>
            <View style={styles.pickerWrapper}>
              <Picker
                selectedValue={defaultReminderTimeZoneDraft}
                onValueChange={(value) => setDefaultReminderTimeZoneDraft(String(value || getDeviceTimeZone()))}
                style={styles.picker}
              >
                {TIME_ZONE_OPTIONS.map((timeZone) => (
                  <Picker.Item key={timeZone} label={timeZone} value={timeZone} />
                ))}
              </Picker>
            </View>

            <View style={styles.modalActionsRow}>
              <TouchableOpacity style={[styles.primaryButton, styles.modalActionButton]} onPress={() => void handleSaveReminderTimeZone()} disabled={isSavingReminderTimeZone}>
                <Text style={styles.primaryButtonText}>{isSavingReminderTimeZone ? 'Saving…' : 'Save Zone'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setDefaultReminderTimeZoneDraft(defaultReminderTimeZone);
                  setShowReminderTimeZoneEditor(false);
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

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
                <Text style={styles.fieldLabel}>Calendar Name (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={appleCalendarNameDraft}
                  onChangeText={setAppleCalendarNameDraft}
                  autoCapitalize="words"
                  autoCorrect={false}
                  placeholder="Home"
                />

                <Text style={styles.deleteHint}>On iOS, connect requests Calendar permission and links the selected device calendar.</Text>
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
                  if (calendarSyncProviderDraft === 'google') {
                    void handleConnectGoogle();
                    return;
                  }

                  if (calendarSyncProviderDraft === 'outlook') {
                    void handleConnectOutlook();
                    return;
                  }

                  if (calendarSyncProviderDraft === 'apple') {
                    void handleConnectApple();
                    return;
                  }
                }}
                disabled={isConnectingGoogle || isConnectingOutlook || isConnectingApple || isSavingCalendarSync || (calendarSyncProviderDraft === 'apple' && !isAppleLocalSyncSupported)}
              >
                <Text style={styles.primaryButtonText}>{isConnectingGoogle || isConnectingOutlook || isConnectingApple ? 'Opening…' : 'Connect'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryButton, styles.modalActionButton]}
                onPress={() => {
                  setCalendarSyncProviderDraft('none');
                  setGoogleCalendarIdDraft(googleCalendarId);
                  setOutlookCalendarEmailDraft(outlookCalendarEmail);
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

      {showDeleteConfirm ? (
        <View style={styles.modalOverlay}>
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
      ) : null}

      {showContactsModal ? (
        <View style={styles.contactsStandalonePanel}>
          <View style={styles.accountHeaderRow}>
            <View style={styles.accountHeaderLeft}>
              <Image source={require('./assets/icon.png')} style={styles.accountHeaderLogo} resizeMode="cover" />
              <View style={styles.accountHeaderTextWrap}>
                <Text style={styles.accountTitle}>Contacts</Text>
                <Text style={styles.accountSubtitle}>Manage your contacts, favorites, deleted, and groups.</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowContactsModal(false)}>
              <Text style={styles.secondaryButtonText}>Back to Account</Text>
            </TouchableOpacity>
          </View>

          {contactsMessage ? <Text style={styles.message}>{contactsMessage}</Text> : null}

          <View style={styles.contactsShell}>
            <View style={styles.contactsSidebar}>
              <TouchableOpacity
                style={[styles.contactsSidebarButton, activeContactsView === 'contacts' && styles.contactsSidebarButtonActive]}
                onPress={() => setActiveContactsView('contacts')}
              >
                <Text style={styles.contactsSidebarButtonText} numberOfLines={1}>Contacts</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contactsSidebarButton, activeContactsView === 'favorites' && styles.contactsSidebarButtonActive]}
                onPress={() => setActiveContactsView('favorites')}
              >
                <Text style={styles.contactsSidebarButtonText} numberOfLines={1}>Favorites</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contactsSidebarButton, activeContactsView === 'deleted' && styles.contactsSidebarButtonActive]}
                onPress={() => setActiveContactsView('deleted')}
              >
                <Text style={styles.contactsSidebarButtonText} numberOfLines={1}>Deleted</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.contactsSidebarButton, activeContactsView === 'groups' && styles.contactsSidebarButtonActive]}
                onPress={() => setActiveContactsView('groups')}
              >
                <Text style={styles.contactsSidebarButtonText} numberOfLines={1}>Groups</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.contactsSidebarButton}
                onPress={() => {
                  setContactsMessage(null);
                  setShowContactsModal(false);
                }}
              >
                <Text style={styles.contactsSidebarButtonText} numberOfLines={1}>Close</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.contactsMainPane}>
              {isLoadingContacts ? (
                <Text style={styles.contactsEmptySubtext}>Loading contacts...</Text>
              ) : null}

              {!isLoadingContacts && isEditingContact ? (
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

              {!isLoadingContacts && !isEditingContact && activeContactsView !== 'groups' ? (
                <>
                  <View style={styles.contactsTopActions}>
                    <TouchableOpacity style={[styles.secondaryButton, styles.contactsTopActionButton]} onPress={openNewContactEditor}>
                      <Text style={styles.secondaryButtonText}>New</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        contactsDisplayMode === 'summary' && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => setContactsDisplayMode('summary')}
                    >
                      <Text style={styles.secondaryButtonText}>Summary</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        contactsDisplayMode === 'detail' && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => {
                        setContactsDisplayMode('detail');
                        setActiveSummaryContactId(null);
                      }}
                    >
                      <Text style={styles.secondaryButtonText}>Detail</Text>
                    </TouchableOpacity>
                  </View>

                  {(activeContactsView === 'contacts' && !activeContacts.length)
                  || (activeContactsView === 'favorites' && !favoriteContacts.length)
                  || (activeContactsView === 'deleted' && !deletedContacts.length) ? (
                    <View style={styles.contactsEmptyState}>
                      <Text style={styles.contactsEmptyIcon}>👥</Text>
                      <Text style={styles.contactsEmptyTitle}>You haven't added any contacts yet</Text>
                    </View>
                  ) : (
                    <ScrollView style={styles.contactsList} contentContainerStyle={styles.contactsListContent} keyboardShouldPersistTaps="handled">
                      {visibleContacts.map((contact) => contactsDisplayMode === 'summary' ? (
                        <TouchableOpacity
                          key={contact.id}
                          style={styles.contactsSummaryRow}
                          onPress={() => setActiveSummaryContactId(contact.id)}
                          activeOpacity={0.8}
                        >
                          <Text style={styles.contactsSummaryRowText} numberOfLines={1}>{`${`${contact.firstName} ${contact.lastName}`.trim()} - ${contact.email}`}</Text>
                        </TouchableOpacity>
                      ) : (
                        <View key={contact.id} style={styles.contactRowCard}>
                          <Text style={styles.contactRowName}>{`${contact.firstName} ${contact.lastName}`.trim()}</Text>
                          <Text style={styles.contactRowMeta}>{contact.email}</Text>
                          {contact.mobileNumber ? <Text style={styles.contactRowMeta}>{contact.mobileNumber}</Text> : null}
                          {contact.company ? <Text style={styles.contactRowMeta}>{`Company: ${contact.company}`}</Text> : null}
                          {contact.birthDate ? <Text style={styles.contactRowMeta}>{`Birth date: ${contact.birthDate}`}</Text> : null}
                          {contact.address ? <Text style={styles.contactRowMeta}>{`Address: ${contact.address}`}</Text> : null}
                          {contact.notes ? <Text style={styles.contactRowMeta}>{`Notes: ${contact.notes}`}</Text> : null}

                          {activeContactsView === 'deleted' ? (
                            <View style={styles.contactsCardActionsRow}>
                              <TouchableOpacity style={styles.secondaryButton} onPress={() => void restoreDeletedContact(contact.id)}>
                                <Text style={styles.secondaryButtonText}>Restore</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.deleteButton} onPress={() => void permanentlyDeleteContact(contact.id)}>
                                <Text style={styles.deleteButtonText}>Delete forever</Text>
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <View style={styles.contactsCardActionsRow}>
                              <TouchableOpacity style={[styles.secondaryButton, styles.contactInlineActionButton]} onPress={() => openEditContactEditor(contact)}>
                                <Text style={styles.secondaryButtonText}>Edit</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={[styles.secondaryButton, styles.contactInlineActionButton]} onPress={() => void toggleFavoriteContact(contact.id)}>
                                <Text style={styles.secondaryButtonText}>{contact.isFavorite ? 'Unfavorite' : 'Favorite'}</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={[styles.deleteButton, styles.contactInlineActionButton]} onPress={() => void softDeleteContact(contact.id)}>
                                <Text style={styles.deleteButtonText}>Delete</Text>
                              </TouchableOpacity>
                            </View>
                          )}
                        </View>
                      ))}
                    </ScrollView>
                  )}
                </>
              ) : null}

              {!isLoadingContacts && !isEditingContact && activeContactsView === 'groups' ? (
                <ScrollView style={styles.contactsList} contentContainerStyle={styles.contactsListContent} keyboardShouldPersistTaps="handled">
                  <View style={styles.contactsTopActions}>
                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        groupsDisplayMode === 'new' && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => setGroupsDisplayMode('new')}
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
                      style={[
                        styles.secondaryButton,
                        styles.contactsTopActionButton,
                        groupsDisplayMode === 'detail' && styles.contactsTopActionButtonActive,
                      ]}
                      onPress={() => setGroupsDisplayMode('detail')}
                    >
                      <Text style={styles.secondaryButtonText}>Detail</Text>
                    </TouchableOpacity>
                  </View>

                  {groupsDisplayMode === 'new' ? (
                    <>
                      <Text style={styles.sectionTitle}>Create group</Text>
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
                      <TouchableOpacity style={styles.primaryButton} onPress={() => void createContactGroup()}>
                        <Text style={styles.primaryButtonText}>Create group</Text>
                      </TouchableOpacity>
                    </>
                  ) : null}

                  {groupsDisplayMode === 'summary' ? (
                    <>
                      <Text style={styles.sectionTitle}>Groups summary</Text>
                      {contactGroups.length ? contactGroups.map((group) => (
                        <TouchableOpacity
                          key={group.id}
                          style={styles.contactsSummaryRow}
                          onPress={() => setActiveSummaryGroupId(group.id)}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.contactsSummaryRowText, styles.groupsSummaryRowText]} numberOfLines={1}>{`${group.name} (${getGroupMemberCount(group)} members)`}</Text>
                        </TouchableOpacity>
                      )) : <Text style={styles.contactsEmptySubtext}>No groups yet. Use New to create one.</Text>}
                    </>
                  ) : null}

                  {groupsDisplayMode === 'detail' ? (
                    <>
                      <Text style={styles.sectionTitle}>Groups</Text>
                      {contactGroups.length ? contactGroups.map((group) => (
                        <View key={group.id} style={styles.contactRowCard}>
                          <Text style={styles.contactRowName}>{group.name}</Text>
                          <Text style={styles.contactRowMeta}>{`${getGroupMemberCount(group)} members`}</Text>
                          {group.description ? <Text style={styles.contactRowMeta}>{group.description}</Text> : null}
                          <View style={styles.contactsCardActionsRow}>
                            <TouchableOpacity
                              style={[styles.secondaryButton, styles.contactInlineActionButton]}
                              onPress={() => {
                                setSelectedGroupId(group.id);
                                setContactsMessage(null);
                              }}
                            >
                              <Text style={styles.secondaryButtonText}>Manage</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.secondaryButton, styles.contactInlineActionButton]}
                              onPress={() => setActiveSummaryGroupId(group.id)}
                            >
                              <Text style={styles.secondaryButtonText}>Summary</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )) : <Text style={styles.contactsEmptySubtext}>No groups yet. Use New to create one.</Text>}

                      <Text style={styles.contactsEmptySubtext}>Select Manage on a group card to open the popup.</Text>
                    </>
                  ) : null}
                </ScrollView>
              ) : null}
            </View>
          </View>

          {selectedGroup && groupsDisplayMode === 'detail' ? (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>{selectedGroup.name}</Text>
                <Text style={styles.contactRowMeta}>{`${getGroupMemberCount(selectedGroup)} members`}</Text>

                <View style={styles.contactsSummaryDetailsCard}>
                  <Text style={styles.fieldLabel}>Group description</Text>
                  <TextInput
                    style={[styles.input, styles.contactsNotesInput]}
                    value={selectedGroupDescriptionDraft}
                    onChangeText={setSelectedGroupDescriptionDraft}
                    placeholder="Describe this group"
                    multiline
                  />
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => void saveSelectedGroupDescription()}>
                    <Text style={styles.secondaryButtonText}>Save Description</Text>
                  </TouchableOpacity>

                  <Text style={styles.sectionTitle}>{`Add contact to ${selectedGroup.name}`}</Text>
                  {contactsAvailableForSelectedGroup.length ? (
                    <>
                      <View style={styles.pickerWrapper}>
                        <Picker
                          selectedValue={selectedContactIdToAdd}
                          onValueChange={(value) => setSelectedContactIdToAdd(String(value || ''))}
                          style={styles.picker}
                        >
                          <Picker.Item label="Select contact" value="" />
                          {contactsAvailableForSelectedGroup.map((entry) => (
                            <Picker.Item key={entry.id} label={`${entry.firstName} ${entry.lastName} (${entry.email})`} value={entry.id} />
                          ))}
                        </Picker>
                      </View>
                      <TouchableOpacity style={styles.primaryButton} onPress={() => void addSelectedContactToSelectedGroup()}>
                        <Text style={styles.primaryButtonText}>Add to group</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <Text style={styles.contactsEmptySubtext}>No remaining contacts to add.</Text>
                  )}

                  <Text style={styles.sectionTitle}>Group members</Text>
                  {selectedGroupMembers.length ? selectedGroupMembers.map((entry) => (
                    <View key={entry.id} style={styles.contactRowCard}>
                      <View style={styles.groupMemberHeaderRow}>
                        <Text style={styles.contactRowName}>{`${entry.firstName} ${entry.lastName}`.trim()}</Text>
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={() => void removeContactFromSelectedGroup(entry.id)}
                        >
                          <Text style={styles.secondaryButtonText}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.contactRowMeta}>{entry.email}</Text>
                    </View>
                  )) : <Text style={styles.contactsEmptySubtext}>No members in this group yet.</Text>}
                </View>

                <View style={styles.modalActionsRow}>
                  <TouchableOpacity style={[styles.secondaryButton, styles.contactsSummaryActionButton]} onPress={() => setSelectedGroupId('')}>
                    <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}

          {activeSummaryGroup ? (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>{activeSummaryGroup.name}</Text>
                <Text style={styles.contactRowMeta}>{`${getGroupMemberCount(activeSummaryGroup)} members`}</Text>
                {activeSummaryGroup.description ? <Text style={styles.contactRowMeta}>{activeSummaryGroup.description}</Text> : null}

                <View style={styles.contactsSummaryDetailsCard}>
                  <Text style={styles.sectionTitle}>Members</Text>
                  {activeSummaryGroupMembers.length ? activeSummaryGroupMembers.map((member) => (
                    <View key={member.id} style={styles.groupSummaryMemberRow}>
                      <Text style={styles.contactRowName}>{`${member.firstName} ${member.lastName}`.trim()}</Text>
                      <Text style={styles.contactRowMeta}>{member.email}</Text>
                    </View>
                  )) : <Text style={styles.contactsEmptySubtext}>No members in this group yet.</Text>}
                </View>

                <View style={styles.modalActionsRow}>
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                    onPress={() => {
                      setSelectedGroupId(activeSummaryGroup.id);
                      setGroupsDisplayMode('detail');
                      setActiveSummaryGroupId(null);
                    }}
                  >
                    <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Detail</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.secondaryButton, styles.contactsSummaryActionButton]} onPress={() => setActiveSummaryGroupId(null)}>
                    <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}

          {activeSummaryContact ? (
            <View style={styles.modalOverlay}>
              <View style={[styles.modalCard, styles.contactsSummaryModalCard]}>
                <Text style={styles.modalTitle}>Contact Summary</Text>

                <View style={styles.contactsSummaryDetailsCard}>
                  <Text style={styles.contactRowName}>{`${activeSummaryContact.firstName} ${activeSummaryContact.lastName}`.trim()}</Text>
                  <Text style={styles.contactRowMeta}>{activeSummaryContact.email}</Text>
                  {activeSummaryContact.mobileNumber ? <Text style={styles.contactRowMeta}>{activeSummaryContact.mobileNumber}</Text> : null}
                  {activeSummaryContact.company ? <Text style={styles.contactRowMeta}>{`Company: ${activeSummaryContact.company}`}</Text> : null}
                  {activeSummaryContact.birthDate ? <Text style={styles.contactRowMeta}>{`Birth date: ${activeSummaryContact.birthDate}`}</Text> : null}
                  {activeSummaryContact.address ? <Text style={styles.contactRowMeta}>{`Address: ${activeSummaryContact.address}`}</Text> : null}
                  {activeSummaryContact.notes ? <Text style={styles.contactRowMeta}>{`Notes: ${activeSummaryContact.notes}`}</Text> : null}
                </View>

                <View style={styles.modalActionsRow}>
                  {activeSummaryContact.deletedAt ? (
                    <>
                      <TouchableOpacity
                        style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                        onPress={() => void restoreDeletedContact(activeSummaryContact.id)}
                      >
                        <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Restore</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.deleteButton, styles.contactsSummaryActionButton]}
                        onPress={() => void permanentlyDeleteContact(activeSummaryContact.id)}
                      >
                        <Text style={styles.deleteButtonText} numberOfLines={1}>Delete forever</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
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
                          void softDeleteContact(activeSummaryContact.id);
                          setActiveSummaryContactId(null);
                        }}
                      >
                        <Text style={styles.deleteButtonText} numberOfLines={1}>Delete</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.contactsSummaryActionButton]}
                    onPress={() => setActiveSummaryContactId(null)}
                  >
                    <Text style={styles.contactsSummaryActionText} numberOfLines={1}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          ) : null}

        </View>
      ) : null}

      {!showContactsModal ? (
      <View style={styles.accountCard}>
        <View style={styles.accountHeaderRow}>
          <View style={styles.accountHeaderLeft}>
            <Image source={require('./assets/icon.png')} style={styles.accountHeaderLogo} resizeMode="cover" />
            <View style={styles.accountHeaderTextWrap}>
              <Text style={styles.accountTitle}>Account</Text>
              <Text style={styles.accountSubtitle}>{user.email}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.secondaryButton} onPress={handleBack}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.accountShell}>
          <View style={styles.accountNav}>
            <TouchableOpacity
              style={[styles.accountNavButton, activeAccountAction === 'profile' && styles.accountNavButtonActive]}
              onPress={() => setActiveAccountAction('profile')}
            >
              <Text style={[styles.accountNavButtonText, activeAccountAction === 'profile' && styles.accountNavButtonTextActive]}>Profile</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.accountNavButton}
              onPress={() => {
                void handleOpenContacts();
              }}
            >
              <Text style={styles.accountNavButtonText}>Contacts</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.accountNavButton, activeAccountAction === 'settings' && styles.accountNavButtonActive]}
              onPress={() => setActiveAccountAction('settings')}
            >
              <Text style={[styles.accountNavButtonText, activeAccountAction === 'settings' && styles.accountNavButtonTextActive]}>Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.accountNavButton, activeAccountAction === 'calendar-sync' && styles.accountNavButtonActive]}
              onPress={() => setActiveAccountAction('calendar-sync')}
            >
              <Text style={[styles.accountNavButtonText, activeAccountAction === 'calendar-sync' && styles.accountNavButtonTextActive]}>Calendar Sync</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.accountNavButton}
              onPress={() => {
                setMessage(null);
                setContactSupportError(null);
                setShowContactSupportModal(true);
              }}
            >
              <Text style={styles.accountNavButtonText}>Contact Us</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.accountNavButton} onPress={handleBack}>
              <Text style={styles.accountNavButtonText}>Close</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.accountMainPane}>
            {message ? <Text style={styles.message}>{message}</Text> : null}

            {activeAccountAction === 'profile' ? (
              <>
                <Text style={styles.sectionTitle}>Personal details</Text>
                <View style={styles.accountDetailsColumns}>
                  <View style={styles.accountDetailsPrimaryColumn}>
                    <View style={styles.accountNameRow}>
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
                    </View>

                    <View style={styles.accountAddressBlock}>
                      <Text style={styles.fieldLabel}>Address</Text>

                      <TextInput
                        style={[styles.input, styles.accountCompactInput]}
                        placeholder="Address line 1"
                        value={addressLine1}
                        onFocus={() => setIsAccountAddressLine1Focused(true)}
                        onBlur={() => {
                          accountAddressBlurTimeoutRef.current = setTimeout(() => {
                            if (isSelectingAccountAddressPredictionRef.current) {
                              isSelectingAccountAddressPredictionRef.current = false;
                              return;
                            }
                            setIsAccountAddressLine1Focused(false);
                            setAddressPredictions([]);
                          }, 120);
                        }}
                        onChangeText={(value) => {
                          setAddressLine1(value);
                          if (message) {
                            setMessage(null);
                          }
                        }}
                      />

                      {isAccountAddressLine1Focused && addressPredictions.length ? (
                        <View style={styles.addressSuggestionsList}>
                          {addressPredictions.map((prediction) => (
                            <TouchableOpacity
                              key={prediction.placeId}
                              style={styles.addressSuggestionItem}
                              onPressIn={() => {
                                isSelectingAccountAddressPredictionRef.current = true;
                                if (accountAddressBlurTimeoutRef.current) {
                                  clearTimeout(accountAddressBlurTimeoutRef.current);
                                }
                              }}
                              onPress={() => void applyAccountAddressPrediction(prediction)}
                            >
                              <Text style={styles.addressSuggestionMainText} numberOfLines={1}>{prediction.mainText}</Text>
                              {prediction.secondaryText ? <Text style={styles.addressSuggestionSecondaryText} numberOfLines={1}>{prediction.secondaryText}</Text> : null}
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : null}

                      <TextInput
                        style={[styles.input, styles.accountCompactInput, !addressLine2.trim() && styles.optionalAddressLine2Input]}
                        placeholder="Address line 2"
                        placeholderTextColor="#94a3b8"
                        value={addressLine2}
                        onChangeText={(value) => {
                          setAddressLine2(value);
                          if (message) {
                            setMessage(null);
                          }
                        }}
                      />

                      <TextInput
                        style={[styles.input, styles.accountCompactInput]}
                        placeholder="City"
                        value={addressCity}
                        onChangeText={(value) => {
                          setAddressCity(value);
                          if (message) {
                            setMessage(null);
                          }
                        }}
                      />

                      <View style={styles.accountAddressCityStateZipRow}>
                        <View style={[styles.accountInlineField, styles.accountStateField]}>
                          <TextInput
                            style={[styles.input, styles.accountCompactInput]}
                            placeholder="State"
                            value={addressState}
                            onChangeText={(value) => {
                              setAddressState(value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2));
                              if (message) {
                                setMessage(null);
                              }
                            }}
                            autoCapitalize="characters"
                            maxLength={2}
                          />
                        </View>

                        <View style={[styles.accountInlineField, styles.accountZipField]}>
                          <TextInput
                            style={[styles.input, styles.accountCompactInput]}
                            placeholder="ZIP"
                            value={addressZip}
                            onChangeText={(value) => {
                              setAddressZip(value.replace(/\D/g, '').slice(0, 5));
                              if (message) {
                                setMessage(null);
                              }
                            }}
                            keyboardType="number-pad"
                            maxLength={5}
                          />
                        </View>
                      </View>
                    </View>

                    <View style={styles.accountMobileBirthRow}>
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
                    <TouchableOpacity style={[styles.passwordToggleRow, styles.accountActionButton]} onPress={() => setShowPasswordModal(true)} activeOpacity={0.8}>
                      <Text style={styles.passwordToggleText}>Change Password</Text>
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
                <View style={styles.deliveryOptionsRow}>
                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption]} onPress={() => void handleDeliveryToggle('device')} activeOpacity={0.8}>
                    <View style={styles.passwordCheckbox}>
                      {deliveryDevice ? <View style={styles.passwordCheckboxChecked} /> : null}
                    </View>
                    <Text style={styles.preferenceToggleText}>Device</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption]} onPress={() => void handleDeliveryToggle('email')} activeOpacity={0.8}>
                    <View style={styles.passwordCheckbox}>
                      {deliveryEmail ? <View style={styles.passwordCheckboxChecked} /> : null}
                    </View>
                    <Text style={styles.preferenceToggleText}>Email</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption, styles.preferenceToggleDisabled]} disabled activeOpacity={1}>
                    <View style={[styles.passwordCheckbox, styles.passwordCheckboxDisabled]} />
                    <Text style={styles.preferenceToggleDisabledText}>Text</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={[styles.preferenceToggleRow, styles.deliveryOption, styles.preferenceToggleDisabled]} disabled activeOpacity={1}>
                    <View style={[styles.passwordCheckbox, styles.passwordCheckboxDisabled]} />
                    <Text style={styles.preferenceToggleDisabledText}>Voice</Text>
                  </TouchableOpacity>
                </View>

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
                </View>
              </View>
            ) : null}

            {activeAccountAction === 'calendar-sync' ? (
              <View style={styles.passwordSection}>
                <Text style={styles.sectionTitle}>Calendar sync</Text>
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
                        <Text style={styles.primaryButtonText}>{isPushingGoogleCalendar ? 'Syncing…' : 'Google Sync'}</Text>
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
                          onPress={() => void handleConnectOutlookFromSection()}
                          disabled={isConnectingOutlook || isUpdatingOutlookConnection}
                        >
                          <Text style={styles.calendarSyncActionText}>{isConnectingOutlook ? 'Opening…' : 'Connect'}</Text>
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
                            onPress={() => void handleConnectOutlookFromSection()}
                            disabled={isConnectingOutlook || isUpdatingOutlookConnection}
                          >
                            <Text style={styles.calendarSyncActionText}>{isConnectingOutlook ? 'Opening…' : 'Connect'}</Text>
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

                <View style={[styles.calendarSyncRow, styles.calendarSyncRowLast]}>
                  <View style={styles.calendarSyncProviderColumn}>
                    <Text style={styles.calendarSyncProviderLabel}>Apple</Text>
                    <Text style={styles.calendarSyncProviderSubtext}>
                      {isAppleConfigured
                        ? `Calendar: ${appleCalendarName || appleCalendarId}`
                        : 'Calendar: Not configured'}
                    </Text>
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
              </View>

              {isAppleConfigured ? (
                <TouchableOpacity
                  style={[styles.primaryButton, styles.syncPushButton]}
                  onPress={() => void handlePushAppleCalendar()}
                  disabled={isPushingAppleCalendar}
                >
                  <Text style={styles.primaryButtonText}>{isPushingAppleCalendar ? 'Syncing…' : 'Sync to Apple Calendar'}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
              </View>
            ) : null}

            <TouchableOpacity style={styles.primaryButton} onPress={handleSaveProfile} disabled={isSaving}>
              <Text style={styles.primaryButtonText}>{isSaving ? 'Saving…' : 'Save Details'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      ) : null}

      {showContactSupportModal ? (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, styles.contactSupportModalCard]}>
            <Text style={styles.modalTitle}>Contact Us</Text>
            <Text style={styles.deleteHint}>Send a message to support.</Text>

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
  const [isMigratingData, setIsMigratingData] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [migrationSummary, setMigrationSummary] = useState<string | null>(null);
  const [accountReminderTimeZone, setAccountReminderTimeZone] = useState(getDeviceTimeZone());

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
        onDeleteAccount={() => {
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
            <View style={styles.headerBrandTextWrap}>
              <Text style={styles.headerBrandTitle}>Remind Me This</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowAccount(true)}>
              <Text style={styles.secondaryButtonText}>Account</Text>
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
    filter: 'blur(24px)',
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
    backdropFilter: 'blur(16px)',
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
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerBrandImage: {
    width: 40,
    height: 40,
    borderRadius: 10,
    marginRight: 10,
  },
  headerBrandTextWrap: {
    flexShrink: 1,
  },
  headerBrandTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
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
    padding: 16,
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
  accountShell: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  accountNav: {
    width: 96,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 6,
    backgroundColor: '#f8fafc',
  },
  accountNavButton: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 5,
    backgroundColor: '#e2e8f0',
  },
  accountNavButtonActive: {
    backgroundColor: '#bfdbfe',
  },
  accountNavButtonText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 10,
    textAlign: 'left',
  },
  accountNavButtonTextActive: {
    color: '#1d4ed8',
  },
  accountMainPane: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#ffffff',
  },
  accountDetailsColumns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    flexWrap: 'nowrap',
  },
  accountDetailsPrimaryColumn: {
    flex: 1,
    minWidth: 0,
    flexBasis: '50%',
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
  contactsModalCard: {
    maxWidth: 980,
  },
  contactsStandalonePanel: {
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
  contactsShell: {
    width: '100%',
    flexDirection: 'row',
    gap: 12,
    minHeight: 420,
  },
  contactsSidebar: {
    width: 90,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 8,
    backgroundColor: '#f8fafc',
    alignSelf: 'stretch',
  },
  contactsSidebarButton: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 6,
    backgroundColor: '#e2e8f0',
  },
  contactsSidebarButtonActive: {
    backgroundColor: '#bfdbfe',
  },
  contactsSidebarButtonText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 11,
    textAlign: 'center',
  },
  contactsMainPane: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#ffffff',
  },
  contactsBody: {
    minHeight: 420,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  contactsTopActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  contactsTopActionButton: {
    minWidth: 96,
  },
  contactsTopActionButtonActive: {
    backgroundColor: '#bfdbfe',
  },
  contactsList: {
    width: '100%',
    maxHeight: 460,
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
  deliveryOptionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 2,
  },
  deliveryOption: {
    marginRight: 12,
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
  calendarSyncProviderLabel: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 14,
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
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#d9e2f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  calendarSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  calendarSyncRowLast: {
    borderBottomWidth: 0,
  },
  calendarSyncProviderColumn: {
    width: 220,
    minWidth: 160,
  },
  calendarSyncProviderLabel: {
    color: '#0f172a',
    fontWeight: '600',
  },
  calendarSyncProviderSubtext: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
  calendarSyncDetailsColumn: {
    flex: 1,
    minWidth: 0,
  },
  calendarSyncStatusColumn: {
    color: '#334155',
    fontWeight: '500',
    marginBottom: 6,
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
    gap: 14,
  },
  calendarSyncActionTextButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  calendarSyncActionText: {
    color: '#0f172a',
    fontWeight: '600',
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
    marginTop: 10,
    marginBottom: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
  },
  googleSyncInlineButton: {
    marginTop: 8,
    marginBottom: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 10,
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
  defaultReminderModalCard: {
    maxWidth: 220,
    padding: 12,
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
