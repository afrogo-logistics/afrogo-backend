/**
 * TRACKING SERVICE - Real-Time Implementation
 * 
 * Responsibilities:
 *   - Real-time parcel tracking
 *   - Live driver location broadcast
 *   - Delivery estimates
 *   - Notifications trigger
 * 
 * Status: PRODUCTION
 */

import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const apigw = new ApiGatewayManagementApiClient({ endpoint: process.env. APIGW_ENDPOINT });
const ddb = new DynamoDBClient({});
const eventBridge = new EventBridgeClient({});

// ============================================================================
// WebSocket CONNECTION HANDLERS
// ============================================================================

export const connectHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const connectionId = event.requestContext.connectionId;
    const trackingId = event.queryStringParameters?.trackingId;

    if (!trackingId) {
      return { statusCode: 400, body: 'Tracking ID required' };
    }

    // Store connection in DynamoDB
    await ddb.send(
      new UpdateItemCommand({
        TableName: 'WebSocketConnections',
        Key: { connectionId: { S: connectionId!  } },
        UpdateExpression: 'SET trackingId = :tid, createdAt = :now',
        ExpressionAttributeValues: {
          ':tid': { S: trackingId },
          ':now': { S: new Date().toISOString() },
        },
      }),
    );

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('Connect error:', error);
    return { statusCode: 500, body: 'Connection failed' };
  }
};

export const disconnectHandler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const connectionId = event.requestContext.connectionId;

    // Remove connection from DynamoDB
    await ddb.send(
      new UpdateItemCommand({
        TableName: 'WebSocketConnections',
        Key: { connectionId: { S: connectionId! } },
        UpdateExpression: 'REMOVE trackingId',
      }),
    );

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Disconnect error:', error);
    return { statusCode: 500, body: 'Disconnection failed' };
  }
};

// ============================================================================
// BROADCAST TRACKING UPDATE
// ============================================================================

export const broadcastTracking = async (parcelId: string, trackingData: any) => {
  try {
    // Find all connections watching this parcel
    const connections = await ddb.send(
      new QueryCommand({
        TableName: 'WebSocketConnections',
        IndexName: 'TrackingIdIndex',
        KeyConditionExpression: 'trackingId = :tid',
        ExpressionAttributeValues: {
          ':tid': { S: parcelId },
        },
      }),
    );

    // Send update to all connected clients
    for (const connection of connections.Items || []) {
      const connectionId = connection.connectionId.S;
      try {
        await apigw.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({
              type: 'TRACKING_UPDATE',
              parcelId,
              tracking: trackingData,
              timestamp: new Date().toISOString(),
            }),
          }),
        );
      } catch (err) {
        console.warn(`Failed to send to connection ${connectionId}:`, err);
      }
    }
  } catch (error) {
    console.error('Broadcast error:', error);
  }
};

// ============================================================================
// DELIVERY ESTIMATE CALCULATION
// ============================================================================

export const calculateDeliveryEstimate = async (parcelId: string, driverId: string) => {
  try {
    // Get driver current location
    const driverRes = await ddb.send(
      new QueryCommand({
        TableName: 'Drivers',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: driverId },
        },
      }),
    );

    if (! driverRes.Items) return null;

    const driver = driverRes.Items[0];
    const location = JSON.parse(driver.currentLocation?. S || '{}');

    // Get parcel destination
    const parcelRes = await ddb.send(
      new QueryCommand({
        TableName: 'Parcels',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: parcelId },
        },
      }),
    );

    if (!parcelRes.Items) return null;

    const parcel = parcelRes. Items[0];
    const recipient = JSON.parse(parcel. recipient?.S || '{}');

    // Calculate distance and ETA (simplified)
    const distance = calculateDistance(
      location.lat,
      location.lng,
      recipient.recipientLat,
      recipient.recipientLng,
    );

    // Assume 40 km/h average speed
    const estimatedMinutes = Math.ceil((distance / 40) * 60);
    const eta = new Date(Date.now() + estimatedMinutes * 60 * 1000);

    return {
      distance,
      estimatedMinutes,
      eta: eta.toISOString(),
    };
  } catch (error) {
    console.error('Estimate calculation error:', error);
    return null;
  }
};

function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math. cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math. atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}