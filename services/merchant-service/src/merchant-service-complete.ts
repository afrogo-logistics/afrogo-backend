/**
 * MERCHANT SERVICE - Production Implementation
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
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// CLIENTS & CONFIG (module-level singletons)
// ============================================================================

const REGION = process.env.AWS_REGION || 'af-south-1';

const ddb = new DynamoDBClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ses = new SESClient({ region: REGION });

const MERCHANTS_TABLE = process.env.MERCHANTS_TABLE_NAME ?? 'Merchants';
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE_NAME ?? 'Analytics';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const DASHBOARD_URL =
  process.env.DASHBOARD_URL ?? 'https://dashboard.afroogo.com';
const SES_SOURCE_EMAIL =
  process.env.SES_SOURCE_EMAIL ?? 'onboarding@afroogo.com';

// ============================================================================
// TYPES
// ============================================================================

interface MerchantRegistrationRequest {
  businessName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  businessType: 'ECOMMERCE' | 'MARKETPLACE' | 'RETAIL' | 'SOCIAL' | 'ENTERPRISE';
  taxId?: string;
  website?: string;
}

type MerchantStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
type MerchantTier = 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
type KycStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface MerchantIntegrations {
  shopify?: { connected: boolean; storeUrl?: string };
  woocommerce?: { connected: boolean; siteUrl?: string };
  api?: { connected: boolean; apiKey?: string };
}

interface MerchantSettings {
  autoRoute: boolean;
  notifyCustomer: boolean;
  insuranceOptIn: boolean;
  defaultService: 'AFROGO_DOOR' | 'AFROCOLLECT';
}

interface Merchant {
  merchantId: string;
  businessName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  businessType: MerchantRegistrationRequest['businessType'];
  taxId?: string;
  website?: string;
  status: MerchantStatus;
  tier: MerchantTier;
  createdAt: string;
  updatedAt: string;
  kycStatus: KycStatus;
  integrations: MerchantIntegrations;
  settings: MerchantSettings;
}

interface MerchantAnalyticsDay {
  date: string;
  shipmentsCount: number;
  revenue: number;
  averageDeliveryTime: number;
  customerSatisfaction: number;
}

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  body: JSON.stringify(body),
});

// ============================================================================
// REGISTER MERCHANT
// ============================================================================

export const registerMerchant: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!USER_POOL_ID) {
      console.error('[Merchant] Missing COGNITO_USER_POOL_ID');
      return jsonResponse(500, {
        error: 'Configuration error (user pool not set)',
      });
    }

    const body: MerchantRegistrationRequest = JSON.parse(event.body || '{}');

    // Validate required fields
    const missing: string[] = [];
    if (!body.businessName) missing.push('businessName');
    if (!body.email) missing.push('email');
    if (!body.phone) missing.push('phone');
    if (!body.city) missing.push('city');
    if (!body.country) missing.push('country');
    if (!body.businessType) missing.push('businessType');

    if (missing.length > 0) {
      return jsonResponse(400, {
        error: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    const merchantId = `MERCHANT#${uuidv4()}`;
    const now = new Date().toISOString();

    console.log('[Merchant] Registering new merchant:', {
      merchantId,
      businessName: body.businessName,
      email: body.email,
    });

    // Step 1: Create Cognito user
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: body.email,
          UserAttributes: [
            { Name: 'email', Value: body.email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'custom:merchantId', Value: merchantId },
          ],
          TemporaryPassword: Math.random().toString(36).substring(2, 15),
          // We manage comms ourselves via SES
          MessageAction: 'SUPPRESS',
        }),
      );
      console.log('[Merchant] Cognito user created:', body.email);
    } catch (cognitoError) {
      console.error('[Merchant] Cognito user creation failed:', cognitoError);
      return jsonResponse(500, { error: 'Failed to create user account' });
    }

    // Step 2: Store merchant in DynamoDB
    try {
      const item: Record<string, { S?: string; N?: string }> = {
        PK: { S: merchantId },
        SK: { S: 'METADATA' },
        merchantId: { S: merchantId },
        businessName: { S: body.businessName },
        email: { S: body.email },
        phone: { S: body.phone },
        city: { S: body.city },
        country: { S: body.country },
        businessType: { S: body.businessType },
        status: { S: 'ACTIVE' },
        tier: { S: 'STARTER' },
        kycStatus: { S: 'PENDING' },
        createdAt: { S: now },
        updatedAt: { S: now },
        integrations: { S: JSON.stringify({} as MerchantIntegrations) },
        settings: {
          S: JSON.stringify({
            autoRoute: true,
            notifyCustomer: true,
            insuranceOptIn: false,
            defaultService: 'AFROGO_DOOR',
          } as MerchantSettings),
        },
        shipmentsMonth: { N: '0' },
        revenueMonth: { N: '0' },
      };

      if (body.taxId) {
        item.taxId = { S: body.taxId };
      }
      if (body.website) {
        item.website = { S: body.website };
      }

      await ddb.send(
        new PutItemCommand({
          TableName: MERCHANTS_TABLE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      console.log('[Merchant] DynamoDB record created:', merchantId);
    } catch (dbError) {
      console.error('[Merchant] DynamoDB write failed:', dbError);
      return jsonResponse(500, { error: 'Failed to store merchant record' });
    }

    // Step 3: Send onboarding email (non-blocking)
    const dashboardUrl = DASHBOARD_URL;
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SES_SOURCE_EMAIL,
          Destination: { ToAddresses: [body.email] },
          Message: {
            Subject: { Data: 'Welcome to AfroGo Logistics!' },
            Body: {
              Html: {
                Data: `
                  <h1>Welcome, ${body.businessName}!</h1>
                  <p>Your merchant account has been created successfully.</p>
                  <p>Your Merchant ID: <strong>${merchantId}</strong></p>
                  <p><a href="${dashboardUrl}/setup?mid=${merchantId}">Complete your setup</a></p>
                  <p>If you have any questions, contact us at support@afroogo.com</p>
                `,
              },
            },
          },
        }),
      );
      console.log('[Merchant] Onboarding email sent:', body.email);
    } catch (emailError) {
      console.warn('[Merchant] Email send failed (non-blocking):', emailError);
    }

    console.log('[Merchant] Registration complete:', merchantId);

    return jsonResponse(201, {
      merchantId,
      message: 'Merchant registration successful',
      setupUrl: `${dashboardUrl}/setup?mid=${merchantId}`,
    });
  } catch (error) {
    console.error('[Merchant] Registration error:', error);
    return jsonResponse(500, {
      error: 'Registration failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================================
// GET MERCHANT DETAILS
// ============================================================================

export const getMerchant: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const merchantId = event.pathParameters?.merchantId;

    if (!merchantId) {
      return jsonResponse(400, { error: 'Merchant ID required in path' });
    }

    console.log('[Merchant] Fetching merchant:', merchantId);

    const res = await ddb.send(
      new GetItemCommand({
        TableName: MERCHANTS_TABLE,
        Key: { PK: { S: merchantId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!res.Item) {
      return jsonResponse(404, { error: 'Merchant not found' });
    }

    const item = res.Item;

    const merchant: Merchant = {
      merchantId: item.merchantId.S as string,
      businessName: item.businessName.S as string,
      email: item.email.S as string,
      phone: item.phone.S as string,
      city: item.city.S as string,
      country: item.country.S as string,
      businessType: item.businessType.S as Merchant['businessType'],
      taxId: item.taxId?.S,
      website: item.website?.S,
      status: item.status.S as MerchantStatus,
      tier: item.tier.S as MerchantTier,
      kycStatus: item.kycStatus.S as KycStatus,
      createdAt: item.createdAt.S as string,
      updatedAt: item.updatedAt.S as string,
      integrations: item.integrations?.S
        ? (JSON.parse(item.integrations.S) as MerchantIntegrations)
        : {},
      settings: item.settings?.S
        ? (JSON.parse(item.settings.S) as MerchantSettings)
        : {
            autoRoute: true,
            notifyCustomer: true,
            insuranceOptIn: false,
            defaultService: 'AFROGO_DOOR',
          },
    };

    return jsonResponse(200, merchant);
  } catch (error) {
    console.error('[Merchant] Get error:', error);
    return jsonResponse(500, { error: 'Failed to retrieve merchant' });
  }
};

// ============================================================================
// UPDATE MERCHANT SETTINGS
// ============================================================================

export const updateMerchantSettings: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const merchantId = event.pathParameters?.merchantId;
    const body = JSON.parse(event.body || '{}');

    if (!merchantId) {
      return jsonResponse(400, { error: 'Merchant ID required in path' });
    }

    const now = new Date().toISOString();

    console.log('[Merchant] Updating settings:', merchantId);

    await ddb.send(
      new UpdateItemCommand({
        TableName: MERCHANTS_TABLE,
        Key: { PK: { S: merchantId }, SK: { S: 'METADATA' } },
        UpdateExpression: 'SET #settings = :settings, #updated = :updated',
        ExpressionAttributeNames: {
          '#settings': 'settings',
          '#updated': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':settings': { S: JSON.stringify(body) },
          ':updated': { S: now },
        },
      }),
    );

    console.log('[Merchant] Settings updated:', merchantId);

    return jsonResponse(200, { message: 'Settings updated successfully' });
  } catch (error) {
    console.error('[Merchant] Update settings error:', error);
    return jsonResponse(500, { error: 'Failed to update settings' });
  }
};

// ============================================================================
// GET MERCHANT ANALYTICS
// ============================================================================

export const getMerchantAnalytics: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const merchantId = event.pathParameters?.merchantId;

    if (!merchantId) {
      return jsonResponse(400, { error: 'Merchant ID required in path' });
    }

    console.log('[Merchant] Fetching analytics:', merchantId);

    const res = await ddb.send(
      new QueryCommand({
        TableName: ANALYTICS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': { S: merchantId },
          ':sk': { S: 'DAILY#' },
        },
        ScanIndexForward: false,
        Limit: 30,
      }),
    );

    const analytics: MerchantAnalyticsDay[] = (res.Items || []).map((item: any) => ({
      date: item.SK?.S?.replace('DAILY#', '') ?? '',
      shipmentsCount: parseInt(item.shipmentsCount?.N ?? '0', 10),
      revenue: parseFloat(item.revenue?.N ?? '0'),
      averageDeliveryTime: parseFloat(item.avgDeliveryTime?.N ?? '0'),
      customerSatisfaction: parseFloat(item.satisfaction?.N ?? '0'),
    }));

    return jsonResponse(200, analytics);
  } catch (error) {
    console.error('[Merchant] Analytics error:', error);
    return jsonResponse(500, { error: 'Failed to retrieve analytics' });
  }
};
