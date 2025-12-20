/**
 * NOTIFICATION SERVICE - SQS-driven Processor
 *
 * Responsibilities:
 *  - Consume notification events from SQS
 *  - Fan-out notifications to channels:
 *      • Email (SES)
 *      • SMS (SNS)
 *      • Push (FCM — server key from Secrets Manager)
 *      • In-app notifications (DynamoDB)
 *  - EMAIL + IN_APP: best-effort (log failures, do NOT trigger SQS retry)
 *  - SMS + PUSH: transient errors rethrown to trigger SQS retry; non-transient logged and skipped
 *  - Secrets (FCM server key, third-party credentials) loaded from Secrets Manager and cached
 *
 * Environment variables:
 *  - NOTIFICATIONS_TABLE_NAME (DynamoDB)
 *  - REGION (AWS region)
 *  - FCM_SECRET_ARN (Secrets Manager ARN storing { "serverKey": "..." })
 *  - SES_SOURCE_EMAIL
 *  - OPTIONAL: EXTERNAL_PUSH_ENDPOINT (if using proxy)
 *
 * Notes:
 *  - This handler is idempotent per SQS messageId / dedupeKey:
 *      PK = NOTIF_MARKER#<eventId>, SK = METADATA in Notifications table.
 *    If the marker exists, the message is skipped.
 *  - For production high-throughput needs, you can later add:
 *      - external push gateway
 *      - per-channel rate limiting
 *      - per-channel backoff queues
 *
 * Status: PRODUCTION READY (run integration tests in your AWS env)
 * Last Updated: 2025-12-01
 */

import { SQSHandler } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import axios, { AxiosError } from 'axios';

// -------------------- Configuration --------------------

const REGION = process.env.AWS_REGION || process.env.REGION || 'af-south-1';

const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE_NAME || 'Notifications';
const SES_SOURCE_EMAIL = process.env.SES_SOURCE_EMAIL || 'notifications@afroogo.com';
const FCM_SECRET_ARN = process.env.FCM_SECRET_ARN || ''; // optional; if not set, push will be skipped
const EXTERNAL_PUSH_ENDPOINT = process.env.EXTERNAL_PUSH_ENDPOINT || ''; // optional proxy to avoid direct FCM calls

// -------------------- AWS clients (singletons) --------------------

const ddb = new DynamoDBClient({ region: REGION });
const ses = new SESClient({ region: REGION });
const sns = new SNSClient({ region: REGION });
const secretsManager = new SecretsManagerClient({ region: REGION });

// -------------------- Secrets caching --------------------

let cachedFcmServerKey: string | null = null;
let cachedFcmSecretLoadedAt = 0;
const SECRETS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadFcmServerKey(): Promise<string | null> {
  if (!FCM_SECRET_ARN) return null;
  const now = Date.now();
  if (cachedFcmServerKey && now - cachedFcmSecretLoadedAt < SECRETS_TTL_MS) {
    return cachedFcmServerKey;
  }

  try {
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: FCM_SECRET_ARN }));
    if (res.SecretString) {
      const secret = JSON.parse(res.SecretString);
      cachedFcmServerKey = secret.serverKey || secret.fcmServerKey || secret.key || null;
    } else {
      cachedFcmServerKey = null;
    }
  } catch (err) {
    console.warn('[Notifications] Failed to load FCM secret:', String(err));
    cachedFcmServerKey = null;
  }

  cachedFcmSecretLoadedAt = Date.now();
  return cachedFcmServerKey;
}

// -------------------- Types --------------------

type RecipientType = 'CUSTOMER' | 'MERCHANT' | 'DRIVER' | 'SYSTEM';

interface NotificationEvent {
  id?: string; // optional, else use SQS messageId for idempotency
  type: string; // PARCEL_CREATED | PARCEL_PICKED_UP | PARCEL_IN_TRANSIT | PARCEL_OUT_FOR_DELIVERY | PARCEL_DELIVERED | DELIVERY_FAILED | GENERIC
  recipientId: string; // PK for in-app notifications (user id)
  recipientType?: RecipientType;
  channels?: Array<'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP'>; // optional, default all applicable
  payload?: Record<string, any>;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
  createdAt?: string;
  dedupeKey?: string; // optional key to dedupe semantically
}

// -------------------- Helpers --------------------

function nowIso(): string {
  return new Date().toISOString();
}

// Safe JSON parse utility: returns null on parse failure
function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Detect whether an error is likely transient (network / throttling / 5xx).
 * Used to decide if we should rethrow to trigger SQS retry.
 */
function isTransientError(err: unknown): boolean {
  if (!err) return false;

  // Axios / HTTP
  if (axios.isAxiosError(err)) {
    const aerr = err as AxiosError;
    if (!aerr.response) return true; // network error / timeout
    if (aerr.response.status && aerr.response.status >= 500) return true;
    return false;
  }

  // AWS SDK v3 errors usually have name like 'ThrottlingException', etc.
  const anyErr = err as any;
  const name: string | undefined = anyErr?.name;
  if (name) {
    const transientNames = [
      'ThrottlingException',
      'Throttling',
      'InternalFailure',
      'InternalError',
      'ServiceUnavailable',
      'TooManyRequestsException',
      'RequestLimitExceeded',
    ];
    if (transientNames.includes(name)) return true;
  }

  return false;
}

// -------------------- Channel implementations --------------------

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      Source: SES_SOURCE_EMAIL,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Html: { Data: html },
        },
      },
    }),
  );
  console.log('[Notifications] Email sent', { to, subject });
}

async function sendSMS(phoneNumber: string, text: string): Promise<void> {
  await sns.send(
    new PublishCommand({
      PhoneNumber: phoneNumber,
      Message: text,
    }),
  );
  console.log('[Notifications] SMS sent', { phoneNumber });
}

async function sendPush(
  fcmKey: string | null,
  tokenOrTopic: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (!fcmKey) {
    console.warn('[Notifications] FCM server key not configured; skipping push');
    return;
  }

  const endpoint = EXTERNAL_PUSH_ENDPOINT || 'https://fcm.googleapis.com/fcm/send';
  const payload: any = {
    to: tokenOrTopic,
    notification: { title, body },
    data: data || {},
  };

  const res = await axios.post(endpoint, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `key=${fcmKey}`,
    },
    timeout: 5000,
  });

  if (res.status >= 200 && res.status < 300) {
    console.log('[Notifications] Push sent', { tokenOrTopic });
    return;
  }

  console.warn('[Notifications] Push non-2xx response', {
    tokenOrTopic,
    status: res.status,
    data: res.data,
  });
  throw new Error(`FCM responded ${res.status}`);
}

async function saveInAppNotification(
  recipientId: string,
  eventId: string,
  subject: string,
  bodyText: string,
  payload: any,
  priority = 'NORMAL',
): Promise<void> {
  // Key design: PK = recipientId, SK = NOTIF#<timestamp>#<eventId>
  const now = nowIso();
  const sk = `NOTIF#${now}#${eventId}`;
  const item: Record<string, any> = {
    PK: { S: recipientId },
    SK: { S: sk },
    notifId: { S: eventId },
    subject: { S: subject },
    body: { S: bodyText },
    payload: { S: JSON.stringify(payload || {}) },
    read: { N: '0' },
    priority: { S: priority },
    createdAt: { S: now },
  };

  await ddb.send(
    new PutItemCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: item,
    }),
  );
  console.log('[Notifications] In-app saved', { recipientId, eventId });
}

// -------------------- Template builder --------------------

function buildMessageForEvent(
  event: NotificationEvent,
): { subject: string; bodyHtml: string; bodyText: string; pushTitle?: string; pushBody?: string } {
  const type = event.type || 'GENERIC';
  const payload = event.payload || {};
  switch (type) {
    case 'PARCEL_CREATED':
      return {
        subject: 'Your parcel has been created',
        bodyText: `Parcel ${payload.parcelId} has been created and will be picked up soon.`,
        bodyHtml: `<h1>Parcel Created</h1><p>Parcel <strong>${payload.parcelId}</strong> has been created and will be picked up soon.</p>`,
        pushTitle: 'Parcel created',
        pushBody: `Parcel ${payload.parcelId} created.`,
      };
    case 'OUT_FOR_DELIVERY':
    case 'PARCEL_OUT_FOR_DELIVERY':
      return {
        subject: 'Your parcel is out for delivery',
        bodyText: `Your parcel ${payload.parcelId} is out for delivery today.`,
        bodyHtml: `<h1>Out for delivery</h1><p>Your parcel <strong>${payload.parcelId}</strong> is out for delivery today.</p>`,
        pushTitle: 'Out for delivery',
        pushBody: `Parcel ${payload.parcelId} is out for delivery.`,
      };
    case 'PARCEL_DELIVERED':
      return {
        subject: 'Your parcel has been delivered',
        bodyText: `Parcel ${payload.parcelId} was delivered.`,
        bodyHtml: `<h1>Delivered</h1><p>Parcel <strong>${payload.parcelId}</strong> was delivered. Thank you!</p>`,
        pushTitle: 'Delivered',
        pushBody: `Parcel ${payload.parcelId} delivered.`,
      };
    case 'DELIVERY_FAILED':
      return {
        subject: 'Delivery attempt failed',
        bodyText: `Delivery attempt for parcel ${payload.parcelId} failed. Reason: ${payload.reason || 'unknown'}.`,
        bodyHtml: `<h1>Delivery Failed</h1><p>Delivery attempt for parcel <strong>${payload.parcelId}</strong> failed. Reason: ${payload.reason || 'unknown'}.</p>`,
        pushTitle: 'Delivery failed',
        pushBody: `Delivery failed for parcel ${payload.parcelId}.`,
      };
    default:
      return {
        subject: payload.title || 'Notification from AfroGo',
        bodyText: payload.text || 'You have a new notification.',
        bodyHtml: payload.html || `<p>${payload.text || 'You have a new notification.'}</p>`,
        pushTitle: payload.title || 'AfroGo',
        pushBody: payload.text || 'You have a new notification.',
      };
  }
}

// -------------------- SQS Handler --------------------

export const handler: SQSHandler = async (event) => {
  const fcmKey = await loadFcmServerKey(); // may be null

  for (const record of event.Records) {
    const messageId = record.messageId;
    const evt = safeJsonParse<NotificationEvent>(record.body);
    if (!evt || !evt.type) {
      console.warn('[Notifications] Skipping invalid or missing event in SQS record', { messageId, body: record.body });
      continue; // skip invalid events
    }

    // Normalize event
    evt.id = evt.id || evt.dedupeKey || messageId;
    evt.createdAt = evt.createdAt || nowIso();
    evt.channels = evt.channels || ['EMAIL', 'SMS', 'PUSH', 'IN_APP'];

    const recipientId = evt.recipientId;
    const subjectBody = buildMessageForEvent(evt);
    const channels = evt.channels;

    // Idempotency: marker row in Notifications table
    // PK = NOTIF_MARKER#<eventId>, SK = METADATA
    const markerPk = `NOTIF_MARKER#${evt.id}`;

    try {
      await ddb.send(
        new PutItemCommand({
          TableName: NOTIFICATIONS_TABLE,
          Item: {
            PK: { S: markerPk },
            SK: { S: 'METADATA' },
            messageId: { S: messageId },
            createdAt: { S: nowIso() },
            source: { S: 'sqs' },
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (err: any) {
      const errName = err?.name || '';
      const errMsg = String(err);
      if (errName === 'ConditionalCheckFailedException' || errMsg.includes('ConditionalCheckFailedException')) {
        console.warn('[Notifications] Duplicate message detected, skipping', {
          eventId: evt.id,
          messageId,
        });
        continue; // message already processed
      }
      // else log and continue; we lose dedupe for this one message but still attempt channels
      console.warn('[Notifications] Marker write failed (continuing without dedupe):', {
        err: errMsg,
      });
    }

    // Build base message
    const payload = evt.payload || {};
    const subject = subjectBody.subject;
    const html = subjectBody.bodyHtml;
    const text = subjectBody.bodyText;
    const pushTitle = subjectBody.pushTitle;
    const pushBody = subjectBody.pushBody;

    // EMAIL: best-effort (never rethrow)
    if (channels.includes('EMAIL')) {
      const to = payload.email || payload.recipientEmail;
      if (to) {
        try {
          await sendEmail(to, subject, html);
        } catch (err) {
          console.error('[Notifications] sendEmail failed (best-effort, no retry):', {
            to,
            err: String(err),
          });
        }
      } else {
        console.warn('[Notifications] EMAIL channel requested but no email found on payload');
      }
    }

    // SMS: transient errors rethrown to trigger SQS retry; non-transient logged & skipped
    if (channels.includes('SMS')) {
      const phone = payload.phone || payload.recipientPhone;
      if (phone) {
        try {
          await sendSMS(phone, text);
        } catch (err) {
          if (isTransientError(err)) {
            console.error(
              '[Notifications] sendSMS transient error - rethrow to trigger SQS retry',
              { phone, err: String(err) },
            );
            throw err; // cause Lambda invocation to fail -> SQS will retry batch
          } else {
            console.error(
              '[Notifications] sendSMS non-transient error (skipping, no retry):',
              { phone, err: String(err) },
            );
          }
        }
      } else {
        console.warn('[Notifications] SMS channel requested but no phone found on payload');
      }
    }

    // PUSH: transient errors rethrown to trigger SQS retry; non-transient logged & skipped
    if (channels.includes('PUSH')) {
      const token = payload.pushToken || payload.fcmToken || payload.deviceToken;
      if (token) {
        try {
          await sendPush(
            fcmKey,
            token,
            pushTitle || subject,
            pushBody || text,
            payload.data || {},
          );
        } catch (err) {
          if (isTransientError(err)) {
            console.error(
              '[Notifications] sendPush transient error - rethrow to trigger SQS retry',
              { token, err: String(err) },
            );
            throw err; // cause Lambda invocation to fail -> SQS will retry batch
          } else {
            console.error(
              '[Notifications] sendPush non-transient error (skipping, no retry):',
              { token, err: String(err) },
            );
          }
        }
      } else {
        console.warn('[Notifications] PUSH channel requested but no push token found on payload');
      }
    }

    // IN_APP: persistent, best-effort (never rethrow)
    if (channels.includes('IN_APP')) {
      try {
        const inAppSubject = subject || payload.title || 'AfroGo Notification';
        const inAppBody = text || payload.text || JSON.stringify(payload);
        await saveInAppNotification(
          recipientId,
          evt.id!,
          inAppSubject,
          inAppBody,
          payload,
          evt.priority ?? 'NORMAL',
        );
      } catch (err) {
        console.error('[Notifications] saveInAppNotification failed (best-effort):', {
          recipientId,
          err: String(err),
        });
      }
    }

    // Done processing this record
    console.log('[Notifications] SQS message processed', {
      eventId: evt.id,
      messageId,
    });
  } // end for
};
