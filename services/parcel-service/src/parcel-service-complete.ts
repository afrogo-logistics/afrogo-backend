/**
 * PARCEL SERVICE - Production Implementation (Version 3)
 *
 * Responsibilities:
 *   - Create parcels (merchant API + webhooks)
 *   - Generate barcode image and upload to S3
 *   - Parcel tracking & status updates
 *   - Minimal validation + sanitization
 *
 * Status: PRODUCTION READY
 * Version: 1.0.0
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import bwipjs from 'bwip-js';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// CONFIG & CLIENTS
// ============================================================================

const REGION = process.env.AWS_REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const PARCELS_TABLE = process.env.PARCELS_TABLE_NAME ?? 'Parcels';
const PARCELS_BUCKET = process.env.PARCELS_BUCKET ?? 'afroogo-parcels';
const TRACKING_URL = process.env.TRACKING_URL ?? 'https://track.afroogo.com';

const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  body: JSON.stringify(body),
});

// ============================================================================
// TYPES
// ============================================================================

interface CreateParcelRequest {
  merchantId: string;
  recipientName: string;
  recipientPhone: string;
  recipientEmail?: string;
  recipientAddress: string;
  recipientLat?: number;
  recipientLng?: number;
  weight: number; // kg
  dimensions?: { length: number; width: number; height: number };
  contents: string;
  serviceType?: 'AFROGO_DOOR' | 'AFROCOLLECT';
  orderId?: string;
  reference?: string;
  insurance?: boolean;
}

type ParcelStatus =
  | 'CREATED'
  | 'ROUTED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FAILED'
  | 'RETURNED';

interface ParcelRecord {
  parcelId: string;
  merchantId: string;
  barcode: string;
  status: ParcelStatus;
  recipient: {
    name: string;
    phone: string;
    email?: string;
    address: string;
    coordinates?: { lat: number; lng: number } | null;
  };
  weight: number;
  dimensions?: { length: number; width: number; height: number } | null;
  contents: string;
  serviceType: string;
  orderId?: string;
  reference?: string;
  insurance: boolean;
  tracking: {
    currentStatus: string;
    statusHistory: Array<{ status: string; timestamp: string; location?: string }>;
    estimatedDelivery?: string | null;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt?: number; // TTL unix epoch seconds
}

// ============================================================================
// HELPERS
// ============================================================================

function sanitizeString(v?: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ttlEpochSeconds(days = 90): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

// ============================================================================
// CREATE PARCEL
// ============================================================================

export const createParcel: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body: CreateParcelRequest = JSON.parse(event.body || '{}');

    // Basic validation & sanitization
    const missing: string[] = [];
    if (!body.merchantId) missing.push('merchantId');
    if (!body.recipientName) missing.push('recipientName');
    if (!body.recipientPhone) missing.push('recipientPhone');
    if (!body.recipientAddress) missing.push('recipientAddress');
    if (!body.contents) missing.push('contents');
    if (body.weight === undefined || body.weight === null) missing.push('weight');

    if (missing.length > 0) {
      return jsonResponse(400, { error: `Missing required fields: ${missing.join(', ')}` });
    }

    const merchantId = sanitizeString(body.merchantId)!;
    const recipientName = sanitizeString(body.recipientName)!;
    const recipientPhone = sanitizeString(body.recipientPhone)!;
    const recipientAddress = sanitizeString(body.recipientAddress)!;
    const recipientEmail = sanitizeString(body.recipientEmail);
    const serviceType = body.serviceType ?? 'AFROGO_DOOR';
    const weight = Number(body.weight) || 0;
    const dimensions = body.dimensions ?? null;
    const contents = sanitizeString(body.contents)!;
    const orderId = sanitizeString(body.orderId);
    const reference = sanitizeString(body.reference);
    const insurance = Boolean(body.insurance);

    // Generate IDs
    const parcelId = `PARCEL#${uuidv4()}`;
    // Human-friendly barcode: AFR + timestamp + random
    const barcode = `AFR${Date.now()}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const createdAt = nowIso();
    const expiresAt = ttlEpochSeconds(90); // 90 days TTL

    // Generate barcode PNG (sync buffer)
    let barcodeBuffer: Buffer;
    try {
      barcodeBuffer = await bwipjs.toBuffer({
        bcid: 'code128', // Barcode type
        text: barcode,
        scale: 3,
        height: 10,
        includetext: true,
        textxalign: 'center',
      });
    } catch (err) {
      console.error('[Parcel] Barcode generation failed:', err);
      return jsonResponse(500, { error: 'Failed to generate barcode' });
    }

    // Upload barcode to S3
    const s3Key = `barcodes/${parcelId}.png`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: PARCELS_BUCKET,
          Key: s3Key,
          Body: barcodeBuffer,
          ContentType: 'image/png',
          ACL: 'private',
        }),
      );
    } catch (err) {
      console.error('[Parcel] S3 upload failed:', err);
      return jsonResponse(500, { error: 'Failed to upload barcode' });
    }

    // Build parcel record
    const parcel: ParcelRecord = {
      parcelId,
      merchantId,
      barcode,
      status: 'CREATED',
      recipient: {
        name: recipientName,
        phone: recipientPhone,
        email: recipientEmail,
        address: recipientAddress,
        coordinates:
          body.recipientLat !== undefined && body.recipientLng !== undefined
            ? { lat: Number(body.recipientLat), lng: Number(body.recipientLng) }
            : null,
      },
      weight,
      dimensions,
      contents,
      serviceType,
      orderId: orderId ?? undefined,
      reference: reference ?? undefined,
      insurance,
      tracking: {
        currentStatus: 'CREATED',
        statusHistory: [{ status: 'CREATED', timestamp: createdAt }],
        estimatedDelivery: null,
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };

    // Persist to DynamoDB
    const item: Record<string, any> = {
      PK: { S: parcelId },
      SK: { S: 'METADATA' },
      parcelId: { S: parcelId },
      merchantId: { S: merchantId },
      barcode: { S: barcode },
      status: { S: parcel.status },
      recipient: { S: JSON.stringify(parcel.recipient) },
      weight: { N: String(parcel.weight) },
      dimensions: { S: JSON.stringify(parcel.dimensions) },
      contents: { S: parcel.contents },
      serviceType: { S: parcel.serviceType },
      insurance: { N: parcel.insurance ? '1' : '0' },
      tracking: { S: JSON.stringify(parcel.tracking) },
      createdAt: { S: parcel.createdAt },
      updatedAt: { S: parcel.updatedAt },
      expiresAt: { N: String(parcel.expiresAt) },
      s3BarcodeKey: { S: s3Key },
    };

    if (parcel.orderId) item.orderId = { S: parcel.orderId };
    if (parcel.reference) item.reference = { S: parcel.reference };

    try {
      await ddb.send(
        new PutItemCommand({
          TableName: PARCELS_TABLE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (dbErr) {
      console.error('[Parcel] DynamoDB write failed:', dbErr);
      return jsonResponse(500, { error: 'Failed to create parcel record' });
    }

    // Return created parcel info
    return jsonResponse(201, {
      parcelId,
      barcode,
      trackingUrl: `${TRACKING_URL}/${parcelId}`,
      s3BarcodeKey: s3Key,
      createdAt,
    });
  } catch (error) {
    console.error('[Parcel] createParcel error:', error);
    return jsonResponse(500, {
      error: 'Failed to create parcel',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================================
// GET PARCEL TRACKING
// ============================================================================

export const getParcelTracking: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const parcelId = event.pathParameters?.parcelId;
    if (!parcelId) {
      return jsonResponse(400, { error: 'Parcel ID required in path' });
    }

    const res = await ddb.send(
      new GetItemCommand({
        TableName: PARCELS_TABLE,
        Key: { PK: { S: parcelId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!res.Item) {
      return jsonResponse(404, { error: 'Parcel not found' });
    }

    const item = res.Item;
    const tracking = item.tracking?.S ? JSON.parse(item.tracking.S) : null;
    const recipient = item.recipient?.S ? JSON.parse(item.recipient.S) : null;

    return jsonResponse(200, {
      parcelId: item.parcelId?.S,
      status: item.status?.S,
      barcode: item.barcode?.S,
      recipient,
      tracking,
      createdAt: item.createdAt?.S,
      updatedAt: item.updatedAt?.S,
      trackingUrl: `${TRACKING_URL}/${parcelId}`,
    });
  } catch (error) {
    console.error('[Parcel] getParcelTracking error:', error);
    return jsonResponse(500, { error: 'Failed to retrieve parcel tracking' });
  }
};

// ============================================================================
// UPDATE PARCEL STATUS
// ============================================================================

export const updateParcelStatus: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const parcelId = event.pathParameters?.parcelId;
    if (!parcelId) {
      return jsonResponse(400, { error: 'Parcel ID required in path' });
    }

    const body = JSON.parse(event.body || '{}');
    const newStatus = body.status as ParcelStatus | undefined;
    const location = sanitizeString(body.location);
    const notes = sanitizeString(body.notes);

    if (!newStatus) {
      return jsonResponse(400, { error: 'status is required in body' });
    }

    const now = nowIso();

    // Fetch current item to build status history
    const getRes = await ddb.send(
      new GetItemCommand({
        TableName: PARCELS_TABLE,
        Key: { PK: { S: parcelId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!getRes.Item) {
      return jsonResponse(404, { error: 'Parcel not found' });
    }

    const currentTracking = getRes.Item.tracking?.S ? JSON.parse(getRes.Item.tracking.S) : null;
    const history = Array.isArray(currentTracking?.statusHistory) ? currentTracking.statusHistory : [];
    history.push({ status: newStatus, timestamp: now, location: location ?? undefined });

    const updatedTracking = {
      currentStatus: newStatus,
      statusHistory: history,
      estimatedDelivery: currentTracking?.estimatedDelivery ?? null,
    };

    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: PARCELS_TABLE,
          Key: { PK: { S: parcelId }, SK: { S: 'METADATA' } },
          UpdateExpression: 'SET #status = :status, #tracking = :tracking, #updated = :updated',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#tracking': 'tracking',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':status': { S: newStatus },
            ':tracking': { S: JSON.stringify(updatedTracking) },
            ':updated': { S: now },
          },
        }),
      );

      console.log('[Parcel] Status updated:', { parcelId, status: newStatus });

      return jsonResponse(200, { message: 'Parcel status updated', parcelId, status: newStatus });
    } catch (dbErr) {
      console.error('[Parcel] UpdateItem failed:', dbErr);
      return jsonResponse(500, { error: 'Failed to update parcel status' });
    }
  } catch (error) {
    console.error('[Parcel] updateParcelStatus error:', error);
    return jsonResponse(500, { error: 'Failed to update parcel status' });
  }
};