/**
 * DRIVER SERVICE - Production Implementation
 *
 * Responsibilities:
 *   - Driver registration & profile management
 *   - Real-time location updates
 *   - Route offers & acceptance
 *   - Earnings tracking (summary)
 *
 * Status: PRODUCTION READY
 * Version: 1.0.0
 * Last Updated: 2025-12-01
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// CLIENTS & CONFIG
// ============================================================================

const REGION = process.env.AWS_REGION || 'af-south-1';
const ddb = new DynamoDBClient({ region: REGION });

const DRIVERS_TABLE = process.env.DRIVERS_TABLE_NAME ?? 'Drivers';
const ROUTES_TABLE = process.env.ROUTES_TABLE_NAME ?? 'Routes';
const DRIVER_LOCATIONS_TABLE =
  process.env.DRIVER_LOCATIONS_TABLE_NAME ?? 'DriverLocations';

// ============================================================================
// TYPES
// ============================================================================

interface DriverRegistrationRequest {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  licenseNumber: string;
  licenseExpiry: string;
  vehicleType: 'LIGHT_COMMERCIAL' | 'RIGID_TRUCK' | 'ARTICULATED';
  vehicleRegistration: string;
}

type DriverStatus = 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

interface Location {
  lat: number;
  lng: number;
  speed: number;
  heading: number;
}

interface DriverEarnings {
  todayZar: number;
  thisWeekZar: number;
  thisMonthZar: number;
}

interface DriverStats {
  routesCompleted: number;
  totalDeliveries: number;
  onTimeRate: number;
  customerRating: number;
}

interface Driver {
  driverId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  status: DriverStatus;
  verificationStatus: VerificationStatus;
  licenseNumber: string;
  licenseExpiry: string;
  vehicleType: DriverRegistrationRequest['vehicleType'];
  vehicleRegistration: string;
  currentLocation?: Location;
  createdAt: string;
  updatedAt: string;
  earnings: DriverEarnings;
  stats: DriverStats;
}

interface RouteOffer {
  routeId: string;
  zoneName: string;
  stopCount: number;
  plannedDistanceKm: number;
  estimatedDurationMin: number;
  financials: {
    totalEarnings: number;
    ratePerParcel: number;
    currency: string;
    modelVersion: string;
    baseRate: number;
    kmFactor: number;
    distanceComponent: number;
  };
  confidence: {
    isGuaranteed: boolean;
    label: string;
  };
}

type EarningsPeriod = 'today' | 'week' | 'month';

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  body: JSON.stringify(body),
});

// Local DynamoDB item attribute shape
type DdbAttr = { S?: string; N?: string };
type DdbItem = Record<string, DdbAttr | undefined>;

// ============================================================================
// REGISTER DRIVER
// ============================================================================

export const registerDriver: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const body: DriverRegistrationRequest = JSON.parse(event.body || '{}');

    // Validate required fields
    const missing: string[] = [];
    if (!body.firstName) missing.push('firstName');
    if (!body.lastName) missing.push('lastName');
    if (!body.phone) missing.push('phone');
    if (!body.email) missing.push('email');
    if (!body.licenseNumber) missing.push('licenseNumber');
    if (!body.licenseExpiry) missing.push('licenseExpiry');
    if (!body.vehicleType) missing.push('vehicleType');
    if (!body.vehicleRegistration) missing.push('vehicleRegistration');

    if (missing.length > 0) {
      return jsonResponse(400, {
        error: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    const driverId = `DRIVER#${uuidv4()}`;
    const now = new Date().toISOString();

    console.log('[Driver] Registering new driver:', {
      driverId,
      firstName: body.firstName,
      phone: body.phone,
    });

    try {
      const item: Record<string, { S?: string; N?: string }> = {
        PK: { S: driverId },
        SK: { S: 'METADATA' },
        driverId: { S: driverId },
        firstName: { S: body.firstName },
        lastName: { S: body.lastName },
        phone: { S: body.phone },
        email: { S: body.email },
        status: { S: 'ACTIVE' },
        verificationStatus: { S: 'PENDING' },
        licenseNumber: { S: body.licenseNumber },
        licenseExpiry: { S: body.licenseExpiry },
        vehicleType: { S: body.vehicleType },
        vehicleRegistration: { S: body.vehicleRegistration },
        createdAt: { S: now },
        updatedAt: { S: now },
        earnings: {
          S: JSON.stringify({
            todayZar: 0,
            thisWeekZar: 0,
            thisMonthZar: 0,
          } as DriverEarnings),
        },
        stats: {
          S: JSON.stringify({
            routesCompleted: 0,
            totalDeliveries: 0,
            onTimeRate: 100,
            customerRating: 5,
          } as DriverStats),
        },
      };

      await ddb.send(
        new PutItemCommand({
          TableName: DRIVERS_TABLE,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );

      console.log('[Driver] Registration complete:', driverId);

      return jsonResponse(201, {
        driverId,
        message: 'Driver registration successful',
      });
    } catch (dbError) {
      console.error('[Driver] DynamoDB write failed:', dbError);
      return jsonResponse(500, { error: 'Failed to store driver record' });
    }
  } catch (error) {
    console.error('[Driver] Registration error:', error);
    return jsonResponse(500, {
      error: 'Registration failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================================
// GET DRIVER PROFILE
// ============================================================================

export const getDriver: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.pathParameters?.driverId;

    if (!driverId) {
      return jsonResponse(400, { error: 'Driver ID required in path' });
    }

    console.log('[Driver] Fetching driver:', driverId);

    const res = await ddb.send(
      new GetItemCommand({
        TableName: DRIVERS_TABLE,
        Key: { PK: { S: driverId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!res.Item) {
      return jsonResponse(404, { error: 'Driver not found' });
    }

    const item = res.Item;

    const driver: Driver = {
      driverId: item.driverId.S as string,
      firstName: item.firstName.S as string,
      lastName: item.lastName.S as string,
      phone: item.phone.S as string,
      email: item.email.S as string,
      status: item.status.S as DriverStatus,
      verificationStatus: item.verificationStatus
        .S as VerificationStatus,
      licenseNumber: item.licenseNumber.S as string,
      licenseExpiry: item.licenseExpiry.S as string,
      vehicleType: item.vehicleType.S as DriverRegistrationRequest['vehicleType'],
      vehicleRegistration: item.vehicleRegistration.S as string,
      currentLocation: item.currentLocation?.S
        ? (JSON.parse(item.currentLocation.S) as Location)
        : undefined,
      createdAt: item.createdAt.S as string,
      updatedAt: item.updatedAt.S as string,
      earnings: item.earnings?.S
        ? (JSON.parse(item.earnings.S) as DriverEarnings)
        : { todayZar: 0, thisWeekZar: 0, thisMonthZar: 0 },
      stats: item.stats?.S
        ? (JSON.parse(item.stats.S) as DriverStats)
        : {
            routesCompleted: 0,
            totalDeliveries: 0,
            onTimeRate: 100,
            customerRating: 5,
          },
    };

    return jsonResponse(200, driver);
  } catch (error) {
    console.error('[Driver] Get error:', error);
    return jsonResponse(500, { error: 'Failed to retrieve driver' });
  }
};

// ============================================================================
// UPDATE DRIVER LOCATION (Real-time)
// ============================================================================

export const updateDriverLocation: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.pathParameters?.driverId;
    const body = JSON.parse(event.body || '{}');
    const { latitude, longitude, speed, heading } = body;

    if (!driverId) {
      return jsonResponse(400, { error: 'Driver ID required in path' });
    }

    if (latitude === undefined || longitude === undefined) {
      return jsonResponse(400, {
        error: 'Latitude and longitude required',
      });
    }

    const now = new Date().toISOString();

    const location: Location = {
      lat: Number(latitude),
      lng: Number(longitude),
      speed: speed !== undefined ? Number(speed) : 0,
      heading: heading !== undefined ? Number(heading) : 0,
    };

    try {
      // Update driver metadata with current location
      await ddb.send(
        new UpdateItemCommand({
          TableName: DRIVERS_TABLE,
          Key: { PK: { S: driverId }, SK: { S: 'METADATA' } },
          UpdateExpression:
            'SET currentLocation = :loc, updatedAt = :updated',
          ExpressionAttributeValues: {
            ':loc': { S: JSON.stringify(location) },
            ':updated': { S: now },
          },
        }),
      );

      // Append ping to DriverLocations table (for history / debugging)
      await ddb.send(
        new PutItemCommand({
          TableName: DRIVER_LOCATIONS_TABLE,
          Item: {
            PK: { S: driverId },
            SK: { S: `PING#${now}` },
            location: { S: JSON.stringify(location) },
            createdAt: { S: now },
            expiresAt: { N: String(Math.floor(Date.now() / 1000) + 604800) }, // 7 days TTL
          },
        }),
      );

      console.log('[Driver] Location updated:', { driverId, location });

      return jsonResponse(200, { message: 'Location updated' });
    } catch (dbError) {
      console.error(
        '[Driver] Location update DynamoDB error:',
        dbError,
      );
      return jsonResponse(500, {
        error: 'Failed to update location',
      });
    }
  } catch (error) {
    console.error('[Driver] Location update error:', error);
    return jsonResponse(500, {
      error: 'Location update failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================================
// GET DRIVER EARNINGS SUMMARY
// ============================================================================

export const getDriverEarnings: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.pathParameters?.driverId;
    const periodParam = event.queryStringParameters?.period ?? 'today';
    const period = (['today', 'week', 'month'].includes(
      periodParam,
    )
      ? periodParam
      : 'today') as EarningsPeriod;

    if (!driverId) {
      return jsonResponse(400, { error: 'Driver ID required in path' });
    }

    console.log('[Driver] Fetching earnings:', { driverId, period });

    const driverRes = await ddb.send(
      new GetItemCommand({
        TableName: DRIVERS_TABLE,
        Key: { PK: { S: driverId }, SK: { S: 'METADATA' } },
      }),
    );

    if (!driverRes.Item) {
      return jsonResponse(404, { error: 'Driver not found' });
    }

    const earnings: DriverEarnings = driverRes.Item.earnings?.S
      ? (JSON.parse(driverRes.Item.earnings.S) as DriverEarnings)
      : { todayZar: 0, thisWeekZar: 0, thisMonthZar: 0 };

    const periodKey = `${period}Zar` as keyof DriverEarnings;
    const totalEarned = earnings[periodKey] ?? 0;

    return jsonResponse(200, {
      period,
      totalEarned,
      currency: 'ZAR',
      breakdown: {
        note: 'Detailed breakdown available from Aurora driver_payouts table',
      },
    });
  } catch (error) {
    console.error('[Driver] Earnings error:', error);
    return jsonResponse(500, {
      error: 'Failed to retrieve earnings summary',
    });
  }
};

// ============================================================================
// GET AVAILABLE ROUTE OFFERS FOR A DRIVER
// ============================================================================

export const getRouteOffers: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.pathParameters?.driverId;

    if (!driverId) {
      return jsonResponse(400, { error: 'Driver ID required in path' });
    }

    console.log('[Driver] Fetching route offers:', driverId);

    // Query routes by status via GSI: StatusIndex
    const res = await ddb.send(
      new QueryCommand({
        TableName: ROUTES_TABLE,
        IndexName: 'StatusIndex',
        KeyConditionExpression: '#status = :offered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':offered': { S: 'OFFERED' },
        },
        Limit: 50,
        ScanIndexForward: false, // newest first
      }),
    );

    const offers: RouteOffer[] = (res.Items ?? [])
      .filter((item: DdbItem) => item.driverId?.S === 'UNASSIGNED')
      .map((item: DdbItem) => {
        const snapshot = item.payoutSnapshot?.S
          ? JSON.parse(item.payoutSnapshot.S)
          : {};
        const plannedKm = Number(item.plannedDistanceKm?.N ?? 0);
        const stopCount = Number(item.stopCount?.N ?? 0);
        const kmFactor =
          typeof snapshot.kmFactor === 'number' ? snapshot.kmFactor : 0.125;
        const baseRate =
          typeof snapshot.baseRate === 'number' ? snapshot.baseRate : 30;
        const ratePerParcel =
          typeof snapshot.ratePerParcel === 'number'
            ? snapshot.ratePerParcel
            : baseRate + kmFactor * plannedKm;
        const totalEarnings =
          typeof snapshot.totalPayout === 'number'
            ? snapshot.totalPayout
            : ratePerParcel * stopCount;

        const distanceComponent = kmFactor * plannedKm;

        return {
          routeId: item.routeId?.S ?? '',
          zoneName: (item.zoneId?.S ?? '').replace(/_/g, ' '),
          stopCount,
          plannedDistanceKm: plannedKm,
          estimatedDurationMin: Number(
            item.estimatedDurationMin?.N ?? 0,
          ),
          financials: {
            totalEarnings,
            ratePerParcel,
            currency: 'ZAR',
            modelVersion: snapshot.modelVersion ?? 'MODEL_C_V1',
            baseRate,
            kmFactor,
            distanceComponent,
          },
          confidence: {
            isGuaranteed: true,
            label: `Fixed payout based on ${plannedKm.toFixed(
              1,
            )}km planned route`,
          },
        };
      });

    return jsonResponse(200, {
      offers,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Driver] Route offers error:', error);
    return jsonResponse(500, { error: 'Failed to retrieve route offers' });
  }
};

// ============================================================================
// ACCEPT ROUTE
// ============================================================================

export const acceptRoute: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const driverId = event.pathParameters?.driverId;
    const routeId = event.pathParameters?.routeId;

    if (!driverId || !routeId) {
      return jsonResponse(400, {
        error: 'Driver ID and Route ID required in path',
      });
    }

    const now = new Date().toISOString();

    console.log('[Driver] Accepting route:', { driverId, routeId });

    try {
      // Assign route to driver if still unassigned
      await ddb.send(
        new UpdateItemCommand({
          TableName: ROUTES_TABLE,
          Key: { PK: { S: `ROUTE#${routeId}` }, SK: { S: 'METADATA' } },
          UpdateExpression:
            'SET #driver = :driver, #status = :status, #updated = :updated',
          ExpressionAttributeNames: {
            '#driver': 'driverId',
            '#status': 'status',
            '#updated': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':driver': { S: driverId },
            ':status': { S: 'ASSIGNED' },
            ':updated': { S: now },
            ':unassigned': { S: 'UNASSIGNED' },
          },
          ConditionExpression: 'driverId = :unassigned',
        }),
      );

      console.log('[Driver] Route accepted:', {
        driverId,
        routeId,
      });

      return jsonResponse(200, {
        message: 'Route accepted successfully',
        driverId,
        routeId,
      });
    } catch (dbError) {
      console.error(
        '[Driver] Route acceptance DynamoDB error:',
        dbError,
      );
      return jsonResponse(500, {
        error: 'Failed to accept route (may already be assigned)',
      });
    }
  } catch (error) {
    console.error('[Driver] Accept route error:', error);
    return jsonResponse(500, {
      error: 'Failed to accept route',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};