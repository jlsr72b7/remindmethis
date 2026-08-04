import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { google } from 'googleapis';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

const verificationBaseUrl = (process.env.EMAIL_VERIFICATION_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const emailFromAddress = process.env.EMAIL_FROM || 'no-reply@special-date-reminder.local';

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpSecure = process.env.SMTP_SECURE === 'true';
const smsProviderName = (process.env.SMS_PROVIDER || 'noop').toLowerCase();
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioFromNumber = process.env.TWILIO_FROM_NUMBER;
const googleOauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleOauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const googleDefaultCalendarId = process.env.GOOGLE_CALENDAR_ID;
const googleOauthRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const googlePlacesApiKey = String(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '').trim();
const outlookOauthClientId = process.env.OUTLOOK_OAUTH_CLIENT_ID;
const outlookOauthClientSecret = process.env.OUTLOOK_OAUTH_CLIENT_SECRET;
const outlookOauthRedirectUri = process.env.OUTLOOK_OAUTH_REDIRECT_URI;
const outlookOauthAuthorityConfig = String(process.env.OUTLOOK_OAUTH_AUTHORITY || process.env.OUTLOOK_OAUTH_TENANT || process.env.OUTLOOK_TENANT_ID || 'common').trim();
const appReturnUrl = (process.env.APP_RETURN_URL || 'http://localhost:8081').replace(/\/$/, '');
const resolveAppReturnUrl = (candidate?: string) => {
  const trimmed = String(candidate || '').trim();
  if (!trimmed) {
    return appReturnUrl;
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';

    if ((protocol === 'http:' || protocol === 'https:') && isLocalHost) {
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    }
  } catch {
    // Fall back to configured app return URL.
  }

  return appReturnUrl;
};

const resolveOutlookAuthorityTenant = () => {
  const normalized = String(outlookOauthAuthorityConfig || '').trim();
  if (!normalized) {
    return 'common';
  }

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    try {
      const parsed = new URL(normalized);
      const pathSegment = parsed.pathname.replace(/^\/+|\/+$/g, '');
      if (pathSegment) {
        return pathSegment;
      }
    } catch {
      return 'common';
    }
  }

  return normalized.replace(/^\/+|\/+$/g, '') || 'common';
};

const outlookOauthTenant = resolveOutlookAuthorityTenant();
const outlookOauthBaseUrl = `https://login.microsoftonline.com/${encodeURIComponent(outlookOauthTenant)}/oauth2/v2.0`;

const getGoogleScopeForPermission = (permission: string) => (
  permission === 'read'
    ? 'https://www.googleapis.com/auth/calendar.readonly'
    : 'https://www.googleapis.com/auth/calendar.events'
);

interface GooglePlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: {
        text?: string;
      };
      structuredFormat?: {
        mainText?: {
          text?: string;
        };
        secondaryText?: {
          text?: string;
        };
      };
    };
  }>;
  error?: {
    message?: string;
  };
}

interface GooglePlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GooglePlacesDetailsResponse {
  id?: string;
  formattedAddress?: string;
  addressComponents?: GooglePlacesAddressComponent[];
  error?: {
    message?: string;
  };
}

const smtpTransport = smtpHost && smtpUser && smtpPass
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    })
  : null;

interface SmsProvider {
  sendText: (to: string, body: string) => Promise<void>;
}

class NoOpSmsProvider implements SmsProvider {
  async sendText(to: string, body: string) {
    console.warn('SMS provider is disabled. Reminder SMS not sent.', { to, body });
  }
}

class TwilioSmsProvider implements SmsProvider {
  private readonly client: ReturnType<typeof twilio>;
  private readonly fromNumber: string;

  constructor(accountSid: string, authToken: string, fromNumber: string) {
    this.client = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
  }

  async sendText(to: string, body: string) {
    await this.client.messages.create({
      to,
      from: this.fromNumber,
      body,
    });
  }
}

const smsProvider: SmsProvider = (() => {
  if (
    smsProviderName === 'twilio'
    && twilioAccountSid
    && twilioAuthToken
    && twilioFromNumber
  ) {
    return new TwilioSmsProvider(twilioAccountSid, twilioAuthToken, twilioFromNumber);
  }

  return new NoOpSmsProvider();
})();

const sendVerificationEmail = async (email: string, token: string) => {
  const verifyUrl = `${verificationBaseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;
  const subject = 'Verify your Special Date Reminder account';
  const textBody = [
    'Welcome to Special Date Reminder.',
    '',
    'Please verify your email address by opening this link:',
    verifyUrl,
    '',
    'This link expires in 24 hours.',
  ].join('\n');

  const htmlBody = `
    <p>Welcome to <strong>Special Date Reminder</strong>.</p>
    <p>Please verify your email address by opening this link:</p>
    <p><a href="${verifyUrl}">${verifyUrl}</a></p>
    <p>This link expires in 24 hours.</p>
  `;

  if (!smtpTransport) {
    console.warn('SMTP is not configured. Verification link (dev only):', verifyUrl);
    return;
  }

  await smtpTransport.sendMail({
    from: emailFromAddress,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  });
};

const sendReminderEmail = async (email: string, payload: {
  eventTitle: string;
  people: string;
  eventDateTime: string;
  eventAllDay: boolean;
  reminderDateTime: string;
  notes?: string;
}) => {
  const eventAt = new Date(payload.eventDateTime);
  const eventDateLabel = eventAt.toLocaleDateString();
  const eventTimeLabel = eventAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const subject = `Reminder: ${payload.eventTitle}`;
  const textBody = [
    'Special Date Reminder notification',
    '',
    `Event: ${payload.eventTitle}`,
    `Who/What: ${payload.people}`,
    `Event date: ${eventDateLabel}`,
    ...(!payload.eventAllDay ? [`Event time: ${eventTimeLabel}`] : []),
    payload.notes ? `Notes: ${payload.notes}` : null,
    '',
    'Automated message, please do not reply.',
  ].filter(Boolean).join('\n');

  const htmlBody = `
    <p><strong>Special Date Reminder notification</strong></p>
    <p><strong>Event:</strong> ${payload.eventTitle}</p>
    <p><strong>Who/What:</strong> ${payload.people}</p>
    <p><strong>Event date:</strong> ${eventDateLabel}</p>
    ${!payload.eventAllDay ? `<p><strong>Event time:</strong> ${eventTimeLabel}</p>` : ''}
    ${payload.notes ? `<p><strong>Notes:</strong> ${payload.notes}</p>` : ''}
    <p>Automated message, please do not reply.</p>
  `;

  if (!smtpTransport) {
    console.warn('SMTP is not configured. Reminder email (dev only):', {
      to: email,
      subject,
      eventDateTime: payload.eventDateTime,
    });
    return;
  }

  await smtpTransport.sendMail({
    from: emailFromAddress,
    to: email,
    subject,
    text: textBody,
    html: htmlBody,
  });
};

const sendReminderSms = async (phoneNumber: string, payload: {
  eventTitle: string;
  people: string;
  eventDateTime: string;
  eventAllDay: boolean;
  notes?: string;
}) => {
  const eventAt = new Date(payload.eventDateTime);
  const eventDateLabel = eventAt.toLocaleDateString();
  const eventTimeLabel = eventAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const messageLines = [
    `Reminder: ${payload.eventTitle}`,
    `Who/What: ${payload.people}`,
    `Event date: ${eventDateLabel}`,
    ...(!payload.eventAllDay ? [`Event time: ${eventTimeLabel}`] : []),
    payload.notes ? `Notes: ${payload.notes}` : null,
    'Automated message, please do not reply.',
  ].filter(Boolean) as string[];

  await smsProvider.sendText(phoneNumber, messageLines.join('\n'));
};

const formatGoogleAllDayDate = (value: string | Date) => {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const escapeHtml = (value: string) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const parseGoogleAddressComponents = (components: GooglePlacesAddressComponent[] = []) => {
  const findComponent = (...types: string[]) => components.find((entry) => types.some((type) => entry.types?.includes(type))) || null;
  const streetNumber = findComponent('street_number')?.longText || '';
  const route = findComponent('route')?.longText || '';
  const locality = findComponent('locality', 'sublocality', 'postal_town')?.longText || '';
  const state = findComponent('administrative_area_level_1')?.shortText || findComponent('administrative_area_level_1')?.longText || '';
  const zip = findComponent('postal_code')?.longText || '';
  const line1 = [streetNumber, route].filter(Boolean).join(' ').trim() || route || streetNumber;

  return {
    line1,
    city: locality,
    state: String(state || '').trim().toUpperCase(),
    zip,
  };
};

const renderGoogleCallbackPage = (options: {
  title: string;
  text: string;
  buttonLabel?: string;
  autoRedirectMs?: number;
  details?: string;
  returnUrl?: string;
}) => {
  const safeReturnUrl = resolveAppReturnUrl(options.returnUrl);
  const escapedReturnUrl = escapeHtml(safeReturnUrl);
  const buttonLabel = options.buttonLabel || 'Return to App';
  const autoRedirectMs = Number.isFinite(options.autoRedirectMs) ? Math.max(0, Math.trunc(options.autoRedirectMs as number)) : 2000;
  const detailsHtml = options.details
    ? `<div class="debugBox"><strong>Details</strong><pre>${escapeHtml(options.details)}</pre></div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
      .card { max-width: 560px; margin: 0 auto; border: 1px solid #d9e2f0; border-radius: 12px; padding: 20px; background: #ffffff; }
      .title { font-size: 20px; font-weight: 700; margin: 0 0 10px 0; }
      .text { margin: 0 0 14px 0; color: #334155; line-height: 1.45; }
      .button { display: inline-block; background: #2563eb; color: #ffffff !important; text-decoration: none; font-weight: 700; border-radius: 9px; padding: 10px 14px; }
      .small { margin-top: 12px; font-size: 12px; color: #64748b; }
      .debugBox { margin-top: 12px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
      .debugBox pre { margin: 8px 0 0 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; color: #0f172a; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 class="title">${escapeHtml(options.title)}</h1>
      <p class="text">${escapeHtml(options.text)}</p>
      ${detailsHtml}
      <a class="button" href="${escapedReturnUrl}">${buttonLabel}</a>
      <p class="small">If the button does not work, open: ${escapedReturnUrl}</p>
    </div>
    <script>
      setTimeout(function () {
        window.location.href = ${JSON.stringify(safeReturnUrl)};
      }, ${autoRedirectMs});
    </script>
  </body>
</html>`;
};

const getOutlookAuthorizeUrl = (state: string, email: string) => {
  const params = new URLSearchParams({
    client_id: String(outlookOauthClientId || '').trim(),
    response_type: 'code',
    redirect_uri: String(outlookOauthRedirectUri || '').trim(),
    response_mode: 'query',
    scope: 'offline_access openid profile User.Read Calendars.ReadWrite',
    state,
    login_hint: email,
    prompt: 'select_account',
  });

  return `${outlookOauthBaseUrl}/authorize?${params.toString()}`;
};

const getRedirectUriCandidates = (redirectUri: string) => {
  const trimmed = String(redirectUri || '').trim();
  const candidates = new Set<string>();

  if (!trimmed) {
    return [] as string[];
  }

  candidates.add(trimmed);
  candidates.add(trimmed.replace(/\/$/, ''));
  if (!trimmed.endsWith('/')) {
    candidates.add(`${trimmed}/`);
  }

  return Array.from(candidates);
};

const isExpiredNonYearlyEvent = (title: string, eventDateTime: Date, frequency: string) => {
  const normalizedTitle = String(title || '').trim().toLowerCase();
  if (normalizedTitle.includes('birthday') || normalizedTitle.includes('anniversary')) {
    return false;
  }

  if (String(frequency).toLowerCase() === 'yearly') {
    return false;
  }

  const timestamp = new Date(eventDateTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp < Date.now();
};

const moveAnnualEventDateToNextOccurrence = (title: string, eventDateTime: Date, eventAllDay: boolean) => {
  const normalizedTitle = String(title || '').trim().toLowerCase();
  const isAnnual = normalizedTitle.includes('birthday') || normalizedTitle.includes('anniversary');
  const timestamp = new Date(eventDateTime).getTime();
  if (!isAnnual || !Number.isFinite(timestamp)) {
    return new Date(eventDateTime);
  }

  const candidate = new Date(eventDateTime);
  if (eventAllDay) {
    candidate.setHours(0, 0, 0, 0);
  }

  const now = new Date();
  if (candidate.getTime() >= now.getTime()) {
    return candidate;
  }

  const withSafeYear = (source: Date, year: number) => {
    const month = source.getMonth();
    const day = source.getDate();
    const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
    const safeDay = Math.min(day, daysInTargetMonth);
    const nextDate = new Date(source);
    nextDate.setFullYear(year, month, safeDay);
    return nextDate;
  };

  let nextOccurrence = withSafeYear(candidate, now.getFullYear());
  if (eventAllDay) {
    nextOccurrence.setHours(0, 0, 0, 0);
  }

  if (nextOccurrence.getTime() < now.getTime()) {
    nextOccurrence = withSafeYear(candidate, now.getFullYear() + 1);
    if (eventAllDay) {
      nextOccurrence.setHours(0, 0, 0, 0);
    }
  }

  return nextOccurrence;
};

const stripPayloadQueryParam = (value: string) => {
  if (!value || !value.includes('payload=')) {
    return value;
  }

  const sanitizeShareAcceptUrl = (candidate: string) => {
    const usesHtmlEntities = candidate.includes('&amp;');
    const normalized = usesHtmlEntities ? candidate.replace(/&amp;/g, '&') : candidate;

    try {
      const parsed = new URL(normalized);
      if (parsed.pathname !== '/shares/accept' || !parsed.searchParams.has('payload')) {
        return candidate;
      }

      parsed.searchParams.delete('payload');
      let cleaned = parsed.toString();

      if (usesHtmlEntities) {
        cleaned = cleaned.replace(/&/g, '&amp;');
      }

      return cleaned;
    } catch {
      const stripped = normalized
        .replace(/([?&])payload=[^&\s<"']*/gi, '$1')
        .replace(/\?&/g, '?')
        .replace(/[?&](?=[\s<"']|$)/g, '');
      return usesHtmlEntities ? stripped.replace(/&/g, '&amp;') : stripped;
    }
  };

  return value.replace(/https?:\/\/[^\s<"']+/gi, (candidate) => sanitizeShareAcceptUrl(candidate));
};

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const mapDatabaseErrorToResponse = (error: unknown) => {
  const err = error as { code?: string; message?: string };

  if (err.code === 'P2021' || (err.message && err.message.includes('does not exist'))) {
    return {
      status: 503,
      body: {
        error: 'database schema is not initialized',
        action: 'Run `npm run prisma:push` (or `npm run prisma:migrate -- --name init`) in backend folder, then retry.',
      },
    };
  }

  if (err.code === 'P1001') {
    return {
      status: 503,
      body: {
        error: 'database is unreachable',
        action: 'Start Postgres (`npm run db:up`) and verify DATABASE_URL in .env.',
      },
    };
  }

  return null;
};

app.get('/admin/user-count', async (_req, res) => {
  try {
    const userCount = await prisma.user.count();
    return res.json({ userCount });
  } catch (error) {
    console.error('user count failed', error);

    const databaseError = mapDatabaseErrorToResponse(error);
    if (databaseError) {
      return res.status(databaseError.status).json(databaseError.body);
    }

    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/admin/event-reminder-counts', async (_req, res) => {
  try {
    const [userCount, eventCount, reminderCount] = await Promise.all([
      prisma.user.count(),
      prisma.event.count(),
      prisma.eventReminder.count(),
    ]);

    return res.json({
      accountCount: userCount,
      userCount,
      eventCount,
      reminderCount,
      totalReminderCount: reminderCount,
    });
  } catch (error) {
    console.error('event/reminder counts failed', error);

    const databaseError = mapDatabaseErrorToResponse(error);
    if (databaseError) {
      return res.status(databaseError.status).json(databaseError.body);
    }

    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/admin/test-reminder-sms', async (req, res) => {
  try {
    const {
      userId,
      phoneNumber,
      message,
    } = req.body ?? {};

    let destination = '';

    if (phoneNumber) {
      destination = String(phoneNumber).trim();
    } else if (userId) {
      const user = await prisma.user.findUnique({ where: { id: String(userId) } });
      if (!user) {
        return res.status(404).json({ error: 'user not found' });
      }

      if (!user.mobileNumber) {
        return res.status(400).json({ error: 'user mobile number is not configured' });
      }

      destination = user.mobileNumber;
    } else {
      return res.status(400).json({ error: 'Provide either phoneNumber or userId' });
    }

    const testMessage = message
      ? String(message)
      : 'Special Date Reminder SMS test successful. Automated message, please do not reply.';

    await smsProvider.sendText(destination, testMessage);

    return res.json({
      success: true,
      provider: smsProviderName,
      destination,
    });
  } catch (error) {
    console.error('admin test reminder sms failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, mobileNumber, fullName, address, birthDate } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const existing = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: 'account already exists' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email: String(email).toLowerCase(),
        passwordHash,
        emailVerified: false,
        emailVerificationToken: verificationToken,
        emailVerificationExpiresAt: verificationExpiresAt,
        mobileNumber: mobileNumber ? String(mobileNumber) : null,
        fullName: fullName ? String(fullName) : null,
        address: address ? String(address) : null,
        birthDate: birthDate ? String(birthDate) : null,
      },
    });

    try {
      await sendVerificationEmail(user.email, verificationToken);
    } catch (mailError) {
      console.error('verification email send failed', mailError);
      return res.status(500).json({ error: 'Account created, but verification email could not be sent. Please try again later.' });
    }

    return res.status(201).json({
      verificationRequired: true,
      message: 'Account created. Please verify your email before signing in.',
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('signup failed', error);

    const databaseError = mapDatabaseErrorToResponse(error);
    if (databaseError) {
      return res.status(databaseError.status).json(databaseError.body);
    }

    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/auth/verify-email', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.status(400).send('<h3>Verification token is missing.</h3>');
    }

    const user = await prisma.user.findUnique({ where: { emailVerificationToken: token } });
    if (!user) {
      return res.status(400).send('<h3>Verification link is invalid.</h3>');
    }

    if (user.emailVerified) {
      return res.status(200).send('<h3>Email already verified. You can now sign in.</h3>');
    }

    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt.getTime() < Date.now()) {
      return res.status(400).send('<h3>Verification link has expired. Please create the account again to receive a new link.</h3>');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });

    return res.status(200).send('<h3>Email verified successfully. You can now sign in.</h3>');
  } catch (error) {
    console.error('verify email failed', error);
    return res.status(500).send('<h3>Internal server error.</h3>');
  }
});

app.post('/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const matches = await bcrypt.compare(String(password), user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ error: 'email not verified. Please verify your email address before signing in.' });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('signin failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  try {
    const { email } = req.body ?? {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!user) {
      return res.status(404).json({ error: 'account not found' });
    }

    const temporaryPassword = `Temp${Date.now().toString().slice(-6)}!A`;
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    return res.json({ temporaryPassword });
  } catch (error) {
    console.error('reset password failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/notifications/reminder-email', async (req, res) => {
  try {
    const {
      userId,
      eventId,
      eventTitle,
      people,
      eventDateTime,
      eventAllDay,
      reminderDateTime,
      notes,
    } = req.body ?? {};

    if (!userId || !eventId || !eventTitle || !people || !eventDateTime || eventAllDay === undefined || !reminderDateTime) {
      return res.status(400).json({
        error: 'userId, eventId, eventTitle, people, eventDateTime, eventAllDay, and reminderDateTime are required',
      });
    }

    const user = await prisma.user.findUnique({ where: { id: String(userId) } });
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    await sendReminderEmail(user.email, {
      eventTitle: String(eventTitle),
      people: String(people),
      eventDateTime: String(eventDateTime),
      eventAllDay: Boolean(eventAllDay),
      reminderDateTime: String(reminderDateTime),
      notes: notes ? String(notes) : undefined,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('reminder email notification failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/notifications/share-email', async (req, res) => {
  try {
    const {
      toEmail,
      subject,
      body,
      htmlBody,
    } = req.body ?? {};

    if (!toEmail || !subject || !body) {
      return res.status(400).json({
        error: 'toEmail, subject, and body are required',
      });
    }

    if (!smtpTransport) {
      return res.status(503).json({
        error: 'SMTP is not configured on the server',
      });
    }

    const textBody = stripPayloadQueryParam(String(body));
    const normalizedHtmlBody = typeof htmlBody === 'string' && htmlBody.trim().length
      ? stripPayloadQueryParam(htmlBody)
      : textBody
          .split('\n')
          .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
          .join('<br />');

    await smtpTransport.sendMail({
      from: emailFromAddress,
      to: String(toEmail).trim(),
      subject: String(subject),
      text: textBody,
      html: normalizedHtmlBody,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('share email notification failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/notifications/reminder-sms', async (req, res) => {
  try {
    const {
      userId,
      eventId,
      eventTitle,
      people,
      eventDateTime,
      eventAllDay,
      notes,
    } = req.body ?? {};

    if (!userId || !eventId || !eventTitle || !people || !eventDateTime || eventAllDay === undefined) {
      return res.status(400).json({
        error: 'userId, eventId, eventTitle, people, eventDateTime, and eventAllDay are required',
      });
    }

    const user = await prisma.user.findUnique({ where: { id: String(userId) } });
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    if (!user.mobileNumber) {
      return res.status(400).json({ error: 'user mobile number is not configured' });
    }

    await sendReminderSms(user.mobileNumber, {
      eventTitle: String(eventTitle),
      people: String(people),
      eventDateTime: String(eventDateTime),
      eventAllDay: Boolean(eventAllDay),
      notes: notes ? String(notes) : undefined,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('reminder sms notification failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/calendar-sync/google/push', async (req, res) => {
  try {
    const { userId, calendarId: requestedCalendarId, events } = req.body ?? {};

    if (!userId || !Array.isArray(events)) {
      return res.status(400).json({
        error: 'userId and events are required',
      });
    }

    const clientId = String(googleOauthClientId || '').trim();
    const clientSecret = String(googleOauthClientSecret || '').trim();
    const calendarId = String(requestedCalendarId || googleDefaultCalendarId || '').trim();

    const credential = await prisma.calendarSyncCredential.findUnique({
      where: {
        userId_provider: {
          userId: String(userId),
          provider: 'google',
        },
      },
    });
    const refreshToken = String(credential?.refreshToken || '').trim();

    if (!clientId || !clientSecret || !refreshToken || !calendarId) {
      return res.status(400).json({
        error: 'Backend Google OAuth client config, connected Google account, and calendarId are required',
      });
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const event of events) {
      try {
        const eventId = String(event?.id || '').trim();
        const title = String(event?.title || '').trim() || 'Special Date';
        const people = String(event?.people || '').trim();
        const notes = event?.notes ? String(event.notes) : '';
        const reminderTimeZone = event?.reminderTimeZone ? String(event.reminderTimeZone) : 'UTC';
        const isAllDay = Boolean(event?.eventAllDay);

        if (!eventId || !event?.eventDateTime) {
          throw new Error('Event is missing required id or eventDateTime');
        }

        const start = isAllDay
          ? { date: formatGoogleAllDayDate(event.eventDateTime) }
          : { dateTime: new Date(event.eventDateTime).toISOString(), timeZone: reminderTimeZone };

        const end = isAllDay
          ? (() => {
              const startDate = new Date(event.eventDateTime);
              const endDate = new Date(startDate);
              endDate.setUTCDate(endDate.getUTCDate() + 1);
              return { date: formatGoogleAllDayDate(endDate) };
            })()
          : { dateTime: new Date(event.eventDateTime).toISOString(), timeZone: reminderTimeZone };

        const descriptionParts = [
          people ? `Person/Group/Place: ${people}` : null,
          notes ? `Notes: ${notes}` : null,
          `Source Event ID: ${eventId}`,
          'Synced from Special Date Reminder',
        ].filter(Boolean);

        const description = descriptionParts.join('\n');

        const existingResponse = await calendar.events.list({
          calendarId,
          maxResults: 1,
          privateExtendedProperty: [`sdrEventId=${eventId}`, `sdrUserId=${String(userId)}`],
          singleEvents: false,
          showDeleted: false,
        });

        const existing = existingResponse.data.items?.[0];

        if (existing?.id) {
          await calendar.events.patch({
            calendarId,
            eventId: existing.id,
            requestBody: {
              summary: title,
              description,
              start,
              end,
              extendedProperties: {
                private: {
                  sdrEventId: eventId,
                  sdrUserId: String(userId),
                },
              },
            },
          });
          updated += 1;
        } else {
          await calendar.events.insert({
            calendarId,
            requestBody: {
              summary: title,
              description,
              start,
              end,
              extendedProperties: {
                private: {
                  sdrEventId: eventId,
                  sdrUserId: String(userId),
                },
              },
            },
          });
          created += 1;
        }
      } catch (eventError) {
        failed += 1;
        errors.push(eventError instanceof Error ? eventError.message : 'Unknown event push error');
      }
    }

    return res.json({
      success: failed === 0,
      created,
      updated,
      failed,
      errors,
    });
  } catch (error) {
    console.error('google calendar push failed', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'internal server error',
    });
  }
});

app.post('/calendar-sync/google/connect-url', async (req, res) => {
  try {
    const { userId, permission, googleId, returnUrl } = req.body ?? {};
    const normalizedUserId = String(userId || '').trim();
    const normalizedPermission = String(permission || 'write').trim().toLowerCase();
    const normalizedGoogleId = String(googleId || '').trim();
    const normalizedReturnUrl = resolveAppReturnUrl(String(returnUrl || '').trim());
    const clientId = String(googleOauthClientId || '').trim();
    const clientSecret = String(googleOauthClientSecret || '').trim();
    const redirectUri = String(googleOauthRedirectUri || '').trim();

    if (!normalizedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!normalizedGoogleId) {
      return res.status(400).json({ error: 'googleId is required' });
    }

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(400).json({ error: 'Backend Google OAuth client config and redirect URI are required' });
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const scope = getGoogleScopeForPermission(normalizedPermission);
    const state = Buffer.from(JSON.stringify({
      userId: normalizedUserId,
      googleId: normalizedGoogleId,
      permission: normalizedPermission === 'read' ? 'read' : 'write',
      returnUrl: normalizedReturnUrl,
      ts: Date.now(),
    }), 'utf8').toString('base64url');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [scope],
      state,
      login_hint: normalizedGoogleId,
    });

    return res.json({ success: true, authUrl });
  } catch (error) {
    console.error('google connect url failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/calendar-sync/google/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const oauthError = String(req.query.error || '').trim();
    const rawState = String(req.query.state || '').trim();
    const clientId = String(googleOauthClientId || '').trim();
    const clientSecret = String(googleOauthClientSecret || '').trim();
    const redirectUri = String(googleOauthRedirectUri || '').trim();

    let callbackReturnUrl = appReturnUrl;
    if (rawState) {
      try {
        const parsedState = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as { returnUrl?: string };
        callbackReturnUrl = resolveAppReturnUrl(parsedState.returnUrl);
      } catch {
        callbackReturnUrl = appReturnUrl;
      }
    }

    if (oauthError) {
      return res.status(200).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection was cancelled.',
        text: 'No changes were made. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        autoRedirectMs: 1200,
        returnUrl: callbackReturnUrl,
      }));
    }

    if (!code) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'The authorization code was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'Backend Google OAuth configuration is incomplete. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    if (!rawState) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'The connection state was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    let state: { userId: string; permission?: string; returnUrl?: string; ts?: number };
    try {
      state = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as { userId: string; permission?: string; returnUrl?: string; ts?: number };
    } catch {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'The connection state was invalid. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    const userId = String(state.userId || '').trim();
    callbackReturnUrl = resolveAppReturnUrl(state.returnUrl);
    if (!userId) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'The account context was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        returnUrl: callbackReturnUrl,
      }));
    }

    let tokenResponse: { tokens: { refresh_token?: string | null; scope?: string | null } } | null = null;
    let tokenError: unknown = null;

    for (const candidateRedirectUri of getRedirectUriCandidates(redirectUri)) {
      try {
        const retryClient = new google.auth.OAuth2(clientId, clientSecret, candidateRedirectUri);
        const response = await retryClient.getToken(code);
        tokenResponse = {
          tokens: {
            refresh_token: response.tokens.refresh_token ? String(response.tokens.refresh_token) : null,
            scope: response.tokens.scope ? String(response.tokens.scope) : null,
          },
        };
        break;
      } catch (error) {
        tokenError = error;
      }
    }

    if (!tokenResponse) {
      console.error('google token exchange failed', tokenError);
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'No refresh token was returned by Google. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        details: tokenError instanceof Error ? tokenError.message : String(tokenError || 'Unknown Google token exchange failure.'),
        returnUrl: callbackReturnUrl,
      }));
    }

    const refreshToken = tokenResponse.tokens.refresh_token ? String(tokenResponse.tokens.refresh_token) : '';

    if (!refreshToken) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Google Calendar connection could not be completed.',
        text: 'No refresh token was returned by Google. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        details: 'The token exchange completed but Google did not return a refresh token.',
        returnUrl: callbackReturnUrl,
      }));
    }

    await prisma.calendarSyncCredential.upsert({
      where: {
        userId_provider: {
          userId,
          provider: 'google',
        },
      },
      create: {
        userId,
        provider: 'google',
        refreshToken,
        scope: tokenResponse.tokens.scope || null,
      },
      update: {
        refreshToken,
        scope: tokenResponse.tokens.scope || null,
      },
    });

    return res.status(200).send(renderGoogleCallbackPage({
      title: 'Google Calendar connected successfully.',
      text: 'You can return to the app now. This page will redirect automatically in 2 seconds.',
      buttonLabel: 'Back to Account',
      autoRedirectMs: 2000,
      returnUrl: callbackReturnUrl,
    }));
  } catch (error) {
    console.error('google auth code exchange failed', error);
    return res.status(500).send(renderGoogleCallbackPage({
      title: 'Google Calendar connection could not be completed.',
      text: 'An unexpected error occurred. Returning you to the app now.',
      buttonLabel: 'Back to Account',
      details: error instanceof Error ? error.message : String(error),
    }));
  }
});

app.get('/calendar-sync/google/status', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const credential = await prisma.calendarSyncCredential.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'google',
        },
      },
    });

    return res.json({
      connected: Boolean(credential?.refreshToken),
    });
  } catch (error) {
    console.error('google connection status failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/calendar-sync/google/disconnect', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    await prisma.calendarSyncCredential.deleteMany({
      where: {
        userId,
        provider: 'google',
      },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('google disconnect failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/calendar-sync/outlook/connect-url', async (req, res) => {
  try {
    const { userId, email, returnUrl } = req.body ?? {};
    const normalizedUserId = String(userId || '').trim();
    const normalizedEmail = String(email || '').trim();
    const normalizedReturnUrl = resolveAppReturnUrl(String(returnUrl || '').trim());

    if (!normalizedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ error: 'email is required' });
    }

    if (!outlookOauthClientId || !outlookOauthClientSecret || !outlookOauthRedirectUri) {
      return res.status(400).json({ error: 'Backend Outlook OAuth client config and redirect URI are required' });
    }

    const state = Buffer.from(JSON.stringify({
      userId: normalizedUserId,
      email: normalizedEmail,
      returnUrl: normalizedReturnUrl,
      ts: Date.now(),
    }), 'utf8').toString('base64url');

    return res.json({
      success: true,
      authUrl: getOutlookAuthorizeUrl(state, normalizedEmail),
    });
  } catch (error) {
    console.error('outlook connect url failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/calendar-sync/outlook/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const oauthError = String(req.query.error || '').trim();
    const rawState = String(req.query.state || '').trim();

    let callbackReturnUrl = appReturnUrl;
    if (rawState) {
      try {
        const parsedState = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as { returnUrl?: string };
        callbackReturnUrl = resolveAppReturnUrl(parsedState.returnUrl);
      } catch {
        callbackReturnUrl = appReturnUrl;
      }
    }

    if (oauthError) {
      return res.status(200).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection was cancelled.',
        text: 'No changes were made. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        autoRedirectMs: 1200,
        returnUrl: callbackReturnUrl,
      }));
    }

    if (!code) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: 'The authorization code was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    if (!outlookOauthClientId || !outlookOauthClientSecret || !outlookOauthRedirectUri) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: 'Backend Outlook OAuth configuration is incomplete. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    if (!rawState) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: 'The connection state was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    let state: { userId: string; email?: string; returnUrl?: string; ts?: number };
    try {
      state = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as { userId: string; email?: string; returnUrl?: string; ts?: number };
    } catch {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: 'The connection state was invalid. Returning you to the app now.',
        buttonLabel: 'Back to Account',
      }));
    }

    const userId = String(state.userId || '').trim();
    callbackReturnUrl = resolveAppReturnUrl(state.returnUrl);
    if (!userId) {
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: 'The account context was missing. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        returnUrl: callbackReturnUrl,
      }));
    }

    let tokenResponse: Response | null = null;
    let tokenData: { refresh_token?: string; scope?: string; error_description?: string; error?: string } | null = null;
    let tokenExchangeError: unknown = null;

    for (const candidateRedirectUri of getRedirectUriCandidates(String(outlookOauthRedirectUri || '').trim())) {
      try {
        tokenResponse = await fetch(`${outlookOauthBaseUrl}/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: String(outlookOauthClientId).trim(),
            client_secret: String(outlookOauthClientSecret).trim(),
            code,
            redirect_uri: candidateRedirectUri,
            grant_type: 'authorization_code',
            scope: 'offline_access openid profile User.Read Calendars.ReadWrite',
          }),
        });

        tokenData = await tokenResponse.json() as { refresh_token?: string; scope?: string; error_description?: string; error?: string };
        if (tokenResponse.ok && tokenData?.refresh_token) {
          break;
        }

        tokenExchangeError = tokenData?.error_description || tokenData?.error || 'Microsoft token exchange failed.';
      } catch (error) {
        tokenExchangeError = error;
      }
    }

    const refreshToken = tokenData?.refresh_token ? String(tokenData.refresh_token) : '';

    if (!tokenResponse || !tokenResponse.ok || !refreshToken) {
      console.error('outlook token exchange failed', tokenExchangeError);
      return res.status(400).send(renderGoogleCallbackPage({
        title: 'Outlook Calendar connection could not be completed.',
        text: tokenData?.error_description ? String(tokenData.error_description) : 'No refresh token was returned by Microsoft. Returning you to the app now.',
        buttonLabel: 'Back to Account',
        details: tokenData?.error_description || tokenData?.error || (tokenExchangeError instanceof Error ? tokenExchangeError.message : String(tokenExchangeError || 'Unknown Outlook token exchange failure.')),
        returnUrl: callbackReturnUrl,
      }));
    }

    const tokenScope = tokenData?.scope ? String(tokenData.scope) : null;

    await prisma.calendarSyncCredential.upsert({
      where: {
        userId_provider: {
          userId,
          provider: 'outlook',
        },
      },
      create: {
        userId,
        provider: 'outlook',
        refreshToken,
        scope: tokenScope,
      },
      update: {
        refreshToken,
        scope: tokenScope,
      },
    });

    return res.status(200).send(renderGoogleCallbackPage({
      title: 'Outlook Calendar connected successfully.',
      text: 'You can return to the app now. This page will redirect automatically in 2 seconds.',
      buttonLabel: 'Back to Account',
      autoRedirectMs: 2000,
      returnUrl: callbackReturnUrl,
    }));
  } catch (error) {
    console.error('outlook auth code exchange failed', error);
    return res.status(500).send(renderGoogleCallbackPage({
      title: 'Outlook Calendar connection could not be completed.',
      text: 'An unexpected error occurred. Returning you to the app now.',
      buttonLabel: 'Back to Account',
      details: error instanceof Error ? error.message : String(error),
    }));
  }
});

app.get('/calendar-sync/outlook/status', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const credential = await prisma.calendarSyncCredential.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'outlook',
        },
      },
    });

    return res.json({
      connected: Boolean(credential?.refreshToken),
    });
  } catch (error) {
    console.error('outlook connection status failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/calendar-sync/outlook/disconnect', async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    await prisma.calendarSyncCredential.deleteMany({
      where: {
        userId,
        provider: 'outlook',
      },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('outlook disconnect failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/users/find-by-email', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ user: null });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('find user by email failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/users/find-by-phone', async (req, res) => {
  try {
    const rawPhone = String(req.query.phone || '').trim();
    const normalizedPhone = rawPhone.replace(/\D/g, '').slice(0, 10);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { mobileNumber: normalizedPhone },
          { mobileNumber: rawPhone },
        ],
      },
    });

    if (!user) {
      return res.json({ user: null });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('find user by phone failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/google/places/autocomplete', async (req, res) => {
  try {
    if (!googlePlacesApiKey) {
      return res.status(500).json({ error: 'Google Places API key is not configured' });
    }

    const input = String(req.query.input || '').trim();
    const sessionToken = String(req.query.sessionToken || '').trim();
    if (!input) {
      return res.status(400).json({ error: 'input is required' });
    }

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': googlePlacesApiKey,
        'X-Goog-FieldMask': [
          'suggestions.placePrediction.placeId',
          'suggestions.placePrediction.text.text',
          'suggestions.placePrediction.structuredFormat.mainText.text',
          'suggestions.placePrediction.structuredFormat.secondaryText.text',
        ].join(','),
      },
      body: JSON.stringify({
        input,
        includedPrimaryTypes: ['street_address'],
        ...(sessionToken ? { sessionToken } : {}),
      }),
    });
    const payload = await response.json() as GooglePlacesAutocompleteResponse;

    if (!response.ok) {
      return res.status(502).json({ error: payload.error?.message || 'Google Places autocomplete failed' });
    }

    return res.json({
      predictions: (payload.suggestions || [])
        .map((entry) => entry.placePrediction)
        .filter((prediction): prediction is NonNullable<typeof prediction> => Boolean(prediction?.placeId))
        .map((prediction) => ({
          placeId: String(prediction.placeId || '').trim(),
          description: prediction.text?.text || prediction.structuredFormat?.mainText?.text || '',
          mainText: prediction.structuredFormat?.mainText?.text || prediction.text?.text || '',
          secondaryText: prediction.structuredFormat?.secondaryText?.text || '',
        })),
    });
  } catch (error) {
    console.error('google places autocomplete failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/google/places/details', async (req, res) => {
  try {
    if (!googlePlacesApiKey) {
      return res.status(500).json({ error: 'Google Places API key is not configured' });
    }

    const placeId = String(req.query.placeId || '').trim();
    const sessionToken = String(req.query.sessionToken || '').trim();
    if (!placeId) {
      return res.status(400).json({ error: 'placeId is required' });
    }

    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': googlePlacesApiKey,
        'X-Goog-FieldMask': 'id,formattedAddress,addressComponents',
        ...(sessionToken ? { 'X-Goog-Session-Token': sessionToken } : {}),
      },
    });
    const payload = await response.json() as GooglePlacesDetailsResponse;

    if (!response.ok) {
      return res.status(502).json({ error: payload.error?.message || 'Google Places details failed' });
    }

    const parsedAddress = parseGoogleAddressComponents(payload.addressComponents || []);

    return res.json({
      address: {
        placeId: payload.id || placeId,
        formattedAddress: payload.formattedAddress || '',
        line1: parsedAddress.line1,
        city: parsedAddress.city,
        state: parsedAddress.state,
        zip: parsedAddress.zip,
      },
    });
  } catch (error) {
    console.error('google places details failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

const findSharedEventDuplicateForRecipient = async (
  tx: Prisma.TransactionClient,
  recipientUserId: string,
  sourceEvent: {
    title: string;
    people: string;
    ageAsOfToday: number | null;
    eventDateTime: Date;
    reminderDateTime: Date;
    reminderTimeZone: string | null;
    eventAllDay: boolean;
    reminderAllDay: boolean;
    frequency: string;
    reminderMode: string | null;
    notes: string | null;
    reminders: Array<{
      reminderDateTime: Date;
      notes: string | null;
    }>;
  },
) => {
  const candidates = await tx.event.findMany({
    where: {
      userId: recipientUserId,
      title: sourceEvent.title,
      eventDateTime: sourceEvent.eventDateTime,
    },
    include: {
      reminders: {
        select: {
          reminderDateTime: true,
          notes: true,
        },
      },
    },
  });

  const normalizeNullableString = (value: string | null | undefined) => {
    const normalized = String(value || '').trim();
    return normalized || null;
  };

  const normalizeReminderEntries = (entries: Array<{ reminderDateTime: Date; notes: string | null }>) => {
    return entries
      .map((entry) => ({
        reminderDateTime: new Date(entry.reminderDateTime).toISOString(),
        notes: normalizeNullableString(entry.notes),
      }))
      .sort((left, right) => left.reminderDateTime.localeCompare(right.reminderDateTime));
  };

  const sourceReminderEntries = normalizeReminderEntries(sourceEvent.reminders);

  return candidates.find((candidate) => {
    if (candidate.people !== sourceEvent.people) {
      return false;
    }

    if (candidate.ageAsOfToday !== sourceEvent.ageAsOfToday) {
      return false;
    }

    if (candidate.reminderDateTime.getTime() !== sourceEvent.reminderDateTime.getTime()) {
      return false;
    }

    if (candidate.eventAllDay !== sourceEvent.eventAllDay || candidate.reminderAllDay !== sourceEvent.reminderAllDay) {
      return false;
    }

    if (candidate.frequency !== sourceEvent.frequency) {
      return false;
    }

    if (normalizeNullableString(candidate.reminderMode) !== normalizeNullableString(sourceEvent.reminderMode)) {
      return false;
    }

    if (normalizeNullableString(candidate.reminderTimeZone) !== normalizeNullableString(sourceEvent.reminderTimeZone)) {
      return false;
    }

    if (normalizeNullableString(candidate.notes) !== normalizeNullableString(sourceEvent.notes)) {
      return false;
    }

    const candidateReminders = normalizeReminderEntries(candidate.reminders.map((entry) => ({
      reminderDateTime: entry.reminderDateTime,
      notes: entry.notes,
    })));

    if (candidateReminders.length !== sourceReminderEntries.length) {
      return false;
    }

    return candidateReminders.every((entry, index) => (
      entry.reminderDateTime === sourceReminderEntries[index].reminderDateTime
      && entry.notes === sourceReminderEntries[index].notes
    ));
  }) || null;
};

const acceptSharedEventForRecipient = async (
  tx: Prisma.TransactionClient,
  recipientUserId: string,
  sourceEvent: {
    title: string;
    people: string;
    ageAsOfToday: number | null;
    eventDateTime: Date;
    reminderDateTime: Date;
    reminderTimeZone: string | null;
    eventAllDay: boolean;
    reminderAllDay: boolean;
    frequency: string;
    reminderMode: string | null;
    notes: string | null;
    reminders: Array<{
      reminderDateTime: Date;
      notes: string | null;
    }>;
  },
) => {
  const existingDuplicate = await findSharedEventDuplicateForRecipient(tx, recipientUserId, sourceEvent);
  if (existingDuplicate) {
    return { duplicated: true };
  }

  const acceptedEventId = crypto.randomUUID();
  await tx.event.create({
    data: {
      id: acceptedEventId,
      userId: recipientUserId,
      title: sourceEvent.title,
      people: sourceEvent.people,
      ageAsOfToday: sourceEvent.ageAsOfToday,
      eventDateTime: sourceEvent.eventDateTime,
      reminderDateTime: sourceEvent.reminderDateTime,
      reminderTimeZone: sourceEvent.reminderTimeZone,
      eventAllDay: sourceEvent.eventAllDay,
      reminderAllDay: sourceEvent.reminderAllDay,
      frequency: sourceEvent.frequency,
      reminderMode: sourceEvent.reminderMode,
      notes: sourceEvent.notes,
      notified: false,
      lastReminderTriggeredAt: null,
    },
  });

  if (sourceEvent.reminders.length) {
    await tx.eventReminder.createMany({
      data: sourceEvent.reminders.map((entry) => ({
        id: crypto.randomUUID(),
        eventId: acceptedEventId,
        reminderDateTime: entry.reminderDateTime,
        notes: entry.notes,
        notified: false,
        lastTriggeredAt: null,
      })),
    });
  }

  return { duplicated: false };
};

app.post('/shares/invite', async (req, res) => {
  try {
    const senderUserId = String(req.body?.senderUserId || '').trim();
    const recipientUserId = String(req.body?.recipientUserId || '').trim();
    const sourceEventId = String(req.body?.sourceEventId || '').trim();
    const message = String(req.body?.message || '').trim();
    const channels = Array.isArray(req.body?.channels)
      ? req.body.channels.map((entry: unknown) => String(entry || '').trim()).filter(Boolean)
      : [];

    if (!senderUserId || !recipientUserId || !sourceEventId) {
      return res.status(400).json({ error: 'senderUserId, recipientUserId, and sourceEventId are required' });
    }

    if (senderUserId === recipientUserId) {
      return res.status(400).json({ error: 'cannot create self share invite' });
    }

    const [senderUser, recipientUser, sourceEvent] = await Promise.all([
      prisma.user.findUnique({ where: { id: senderUserId }, select: { id: true } }),
      prisma.user.findUnique({ where: { id: recipientUserId }, select: { id: true } }),
      prisma.event.findUnique({ where: { id: sourceEventId }, select: { id: true, userId: true } }),
    ]);

    if (!senderUser || !recipientUser || !sourceEvent) {
      return res.status(404).json({ error: 'sender, recipient, or source event was not found' });
    }

    if (sourceEvent.userId !== senderUserId) {
      return res.status(403).json({ error: 'source event does not belong to sender' });
    }

    await prisma.shareInvite.upsert({
      where: {
        recipientUserId_sourceEventId: {
          recipientUserId,
          sourceEventId,
        },
      },
      create: {
        senderUserId,
        recipientUserId,
        sourceEventId,
        message: message || null,
        channels: channels.length ? JSON.stringify(channels) : null,
      },
      update: {
        senderUserId,
        message: message || null,
        channels: channels.length ? JSON.stringify(channels) : null,
        acceptedAt: null,
        dismissedAt: null,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('share invite create failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/shares/pending', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const invites = await prisma.shareInvite.findMany({
      where: {
        recipientUserId: userId,
        acceptedAt: null,
        dismissedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            fullName: true,
          },
        },
        sourceEvent: {
          select: {
            id: true,
            title: true,
            people: true,
            ageAsOfToday: true,
            eventDateTime: true,
            eventAllDay: true,
            reminderDateTime: true,
            reminderAllDay: true,
            reminderTimeZone: true,
            frequency: true,
            reminderMode: true,
            notes: true,
          },
        },
      },
    });

    return res.json({
      invites: invites.map((invite) => ({
        id: invite.id,
        message: invite.message,
        channels: invite.channels,
        createdAt: invite.createdAt,
        sender: invite.sender,
        sourceEvent: invite.sourceEvent,
      })),
    });
  } catch (error) {
    console.error('load pending share invites failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/shares/respond', async (req, res) => {
  try {
    const inviteId = String(req.body?.inviteId || '').trim();
    const userId = String(req.body?.userId || '').trim();
    const action = String(req.body?.action || '').trim().toLowerCase();

    if (!inviteId || !userId || (action !== 'accept' && action !== 'dismiss')) {
      return res.status(400).json({ error: 'inviteId, userId, and action(accept|dismiss) are required' });
    }

    const invite = await prisma.shareInvite.findUnique({
      where: { id: inviteId },
      include: {
        sourceEvent: {
          include: {
            reminders: true,
          },
        },
      },
    });

    if (!invite) {
      return res.status(404).json({ error: 'invite not found' });
    }

    if (invite.recipientUserId !== userId) {
      return res.status(403).json({ error: 'invite does not belong to this user' });
    }

    if (action === 'dismiss') {
      await prisma.shareInvite.update({
        where: { id: inviteId },
        data: {
          dismissedAt: new Date(),
        },
      });
      return res.json({ success: true, accepted: false });
    }

    const acceptance = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const accepted = await acceptSharedEventForRecipient(tx, userId, {
        title: invite.sourceEvent.title,
        people: invite.sourceEvent.people,
        ageAsOfToday: invite.sourceEvent.ageAsOfToday,
        eventDateTime: invite.sourceEvent.eventDateTime,
        reminderDateTime: invite.sourceEvent.reminderDateTime,
        reminderTimeZone: invite.sourceEvent.reminderTimeZone,
        eventAllDay: invite.sourceEvent.eventAllDay,
        reminderAllDay: invite.sourceEvent.reminderAllDay,
        frequency: invite.sourceEvent.frequency,
        reminderMode: invite.sourceEvent.reminderMode,
        notes: invite.sourceEvent.notes,
        reminders: invite.sourceEvent.reminders,
      });

      await tx.shareInvite.update({
        where: { id: inviteId },
        data: {
          acceptedAt: new Date(),
          dismissedAt: null,
        },
      });

      return accepted;
    });

    return res.json({
      success: true,
      accepted: true,
      duplicate: acceptance.duplicated,
    });
  } catch (error) {
    console.error('share invite response failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/shares/accept', async (req, res) => {
  try {
    const recipientUserId = String(req.query.recipient || '').trim();
    const sourceEventId = String(req.query.event || '').trim();

    if (!recipientUserId || !sourceEventId) {
      return res.status(400).send('<h3>Invalid share link. Recipient and event are required.</h3>');
    }

    const [recipientUser, sourceEvent] = await Promise.all([
      prisma.user.findUnique({ where: { id: recipientUserId } }),
      prisma.event.findUnique({ where: { id: sourceEventId }, include: { reminders: true } }),
    ]);

    if (!recipientUser) {
      return res.status(404).send('<h3>Recipient account was not found.</h3>');
    }

    if (!sourceEvent) {
      return res.status(404).send('<h3>The shared event could not be found.</h3>');
    }

    if (sourceEvent.userId === recipientUserId) {
      return res.status(200).send('<h3>This event already belongs to this account.</h3>');
    }

    const acceptance = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const accepted = await acceptSharedEventForRecipient(tx, recipientUserId, {
        title: sourceEvent.title,
        people: sourceEvent.people,
        ageAsOfToday: sourceEvent.ageAsOfToday,
        eventDateTime: sourceEvent.eventDateTime,
        reminderDateTime: sourceEvent.reminderDateTime,
        reminderTimeZone: sourceEvent.reminderTimeZone,
        eventAllDay: sourceEvent.eventAllDay,
        reminderAllDay: sourceEvent.reminderAllDay,
        frequency: sourceEvent.frequency,
        reminderMode: sourceEvent.reminderMode,
        notes: sourceEvent.notes,
        reminders: sourceEvent.reminders,
      });

      await tx.shareInvite.updateMany({
        where: {
          recipientUserId,
          sourceEventId,
          acceptedAt: null,
        },
        data: {
          acceptedAt: new Date(),
          dismissedAt: null,
        },
      });

      return accepted;
    });

    if (acceptance.duplicated) {
      return res.status(200).send('<h3>This shared event is already in your account.</h3>');
    }

    return res.status(200).send('<h3>Shared event accepted successfully. You can close this tab.</h3>');
  } catch (error) {
    console.error('accept shared event failed', error);
    return res.status(500).send('<h3>Unable to accept this shared event right now. Please try again later.</h3>');
  }
});

app.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('load user failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.patch('/users/:userId/profile', async (req, res) => {
  try {
    const { userId } = req.params;
    const { mobileNumber, fullName, address, birthDate } = req.body ?? {};

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        mobileNumber: mobileNumber === undefined ? undefined : (mobileNumber ? String(mobileNumber) : null),
        fullName: fullName === undefined ? undefined : (fullName ? String(fullName) : null),
        address: address === undefined ? undefined : (address ? String(address) : null),
        birthDate: birthDate === undefined ? undefined : (birthDate ? String(birthDate) : null),
      },
    });

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobileNumber,
        fullName: user.fullName,
        address: user.address,
        birthDate: user.birthDate,
      },
    });
  } catch (error) {
    console.error('update profile failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/users/:userId/change-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { currentPassword, newPassword } = req.body ?? {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    const matches = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!matches) {
      return res.status(400).json({ error: 'The current password is incorrect.' });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('change password failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.delete('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await prisma.user.delete({ where: { id: userId } });
    return res.json({ success: true });
  } catch (error) {
    console.error('delete user failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/users/:userId/events', async (req, res) => {
  try {
    const { userId } = req.params;

    const staleEvents = await prisma.event.findMany({
      where: { userId },
      select: { id: true, title: true, eventDateTime: true, frequency: true },
    });
    const staleEventIds = staleEvents
      .filter((event) => isExpiredNonYearlyEvent(event.title, event.eventDateTime, event.frequency))
      .map((event) => event.id);

    if (staleEventIds.length) {
      await prisma.event.deleteMany({ where: { id: { in: staleEventIds } } });
    }

    const events = await prisma.event.findMany({
      where: { userId },
      include: { reminders: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ events });
  } catch (error) {
    console.error('load events failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.put('/users/:userId/events', async (req, res) => {
  try {
    const { userId } = req.params;
    const { events } = req.body ?? {};

    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events array is required' });
    }

    const incomingEvents = events.filter((event: any) => !isExpiredNonYearlyEvent(
      String(event.title || ''),
      new Date(event.eventDateTime),
      String(event.frequency || ''),
    ));

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.event.findMany({
        where: { userId },
        select: { id: true },
      });

      const existingIds = new Set<string>(existing.map((event: { id: string }) => event.id));
      const incomingIds = new Set<string>(incomingEvents.map((event: any) => String(event.id)));

      const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
      if (toDelete.length) {
        await tx.event.deleteMany({ where: { id: { in: toDelete } } });
      }

      for (const event of incomingEvents) {
        const normalizedTitle = String(event.title);
        const normalizedEventAllDay = Boolean(event.eventAllDay);
        const normalizedEventDateTime = moveAnnualEventDateToNextOccurrence(
          normalizedTitle,
          new Date(event.eventDateTime),
          normalizedEventAllDay,
        );
        const requestedEventId = String(event.id);
        const eventWithSameId = await tx.event.findUnique({
          where: { id: requestedEventId },
          select: { userId: true },
        });
        const eventId = eventWithSameId && eventWithSameId.userId !== userId
          ? crypto.randomUUID()
          : requestedEventId;
        const remapReminderIds = eventId !== requestedEventId;

        await tx.event.upsert({
          where: { id: eventId },
          create: {
            id: eventId,
            userId,
            title: normalizedTitle,
            people: String(event.people),
            ageAsOfToday: event.ageAsOfToday === undefined || event.ageAsOfToday === null || String(event.ageAsOfToday).trim() === ''
              ? null
              : Number.parseInt(String(event.ageAsOfToday), 10),
            eventDateTime: normalizedEventDateTime,
            reminderDateTime: new Date(event.reminderDateTime),
            reminderTimeZone: event.reminderTimeZone ? String(event.reminderTimeZone) : null,
            eventAllDay: normalizedEventAllDay,
            reminderAllDay: Boolean(event.reminderAllDay),
            frequency: String(event.frequency),
            reminderMode: event.reminderMode ? String(event.reminderMode) : null,
            notes: event.notes ? String(event.notes) : null,
            notified: event.notified === undefined ? false : Boolean(event.notified),
            lastReminderTriggeredAt: event.lastReminderTriggeredAt ? new Date(event.lastReminderTriggeredAt) : null,
          },
          update: {
            title: normalizedTitle,
            people: String(event.people),
            ageAsOfToday: event.ageAsOfToday === undefined || event.ageAsOfToday === null || String(event.ageAsOfToday).trim() === ''
              ? null
              : Number.parseInt(String(event.ageAsOfToday), 10),
            eventDateTime: normalizedEventDateTime,
            reminderDateTime: new Date(event.reminderDateTime),
            reminderTimeZone: event.reminderTimeZone ? String(event.reminderTimeZone) : null,
            eventAllDay: normalizedEventAllDay,
            reminderAllDay: Boolean(event.reminderAllDay),
            frequency: String(event.frequency),
            reminderMode: event.reminderMode ? String(event.reminderMode) : null,
            notes: event.notes ? String(event.notes) : null,
            notified: event.notified === undefined ? false : Boolean(event.notified),
            lastReminderTriggeredAt: event.lastReminderTriggeredAt ? new Date(event.lastReminderTriggeredAt) : null,
          },
        });

        await tx.eventReminder.deleteMany({ where: { eventId } });

        const reminders = Array.isArray(event.variableReminders) ? event.variableReminders : [];
        if (reminders.length) {
          await tx.eventReminder.createMany({
            data: reminders.map((entry: any) => ({
              // EventReminder IDs are globally unique; do not reuse client IDs across different events.
              id: crypto.randomUUID(),
              eventId,
              reminderDateTime: new Date(entry.reminderDateTime),
              notes: entry.notes ? String(entry.notes) : null,
              notified: entry.notified === undefined ? false : Boolean(entry.notified),
              lastTriggeredAt: entry.lastTriggeredAt ? new Date(entry.lastTriggeredAt) : null,
            })),
          });
        }
      }
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('save events failed', error);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(port, () => {
  console.log(`backend listening on port ${port}`);
});
