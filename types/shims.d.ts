// Lightweight shims for modules that aren't installed in the root package.json
// This keeps tsc from failing on many service-level runtime deps while
// we adopt a per-service dependency strategy.

// Wildcard and explicit declarations for AWS SDK v3 clients used across services
declare module '@aws-sdk/*';
declare module '@aws-sdk/client-*';
// Explicit client modules (kept for clarity)
declare module '@aws-sdk/client-dynamodb';
declare module '@aws-sdk/client-s3';
declare module '@aws-sdk/client-ses';
declare module '@aws-sdk/client-secrets-manager';
declare module '@aws-sdk/client-ssm';
declare module '@aws-sdk/client-cloudwatch';
declare module '@aws-sdk/client-sqs';
declare module '@aws-sdk/client-sns';
declare module '@aws-sdk/client-cognito-identity-provider';
declare module '@aws-sdk/client-apigatewaymanagementapi';
declare module '@aws-sdk/client-eventbridge';

declare module 'bwip-js';
declare module 'node-bwip-js';
declare module 'uuid';
declare module 'pg';

export {};
