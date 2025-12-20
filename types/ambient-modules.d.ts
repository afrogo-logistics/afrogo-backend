// Ambient module declarations to silence missing third-party type packages
// Conservative Option A: declare modules used across services so tsc can proceed

declare module 'pdfkit';
declare module 'bwip-js';

// AWS SDK v3 clients (common subset used across services)
declare module '@aws-sdk/client-dynamodb';
declare module '@aws-sdk/client-cloudwatch';
declare module '@aws-sdk/client-secrets-manager';
declare module '@aws-sdk/client-s3';
declare module '@aws-sdk/client-ses';
declare module '@aws-sdk/client-sns';
declare module '@aws-sdk/client-sqs';
declare module '@aws-sdk/client-ssm';
declare module '@aws-sdk/client-eventbridge';
declare module '@aws-sdk/client-apigatewaymanagementapi';
declare module '@aws-sdk/client-cognito-identity-provider';

// Allow a generic wildcard for other @aws-sdk/* modules if referenced
declare module '@aws-sdk/*';

// Misc
declare module 'pdfkit/js/pdfkit';

// NOTE: removed the global wildcard `declare module '*'` — it caused downstream
// type resolution to break (clobbered real modules). We keep specific shims only.
