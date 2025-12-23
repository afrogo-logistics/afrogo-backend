import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';

interface Props extends cdk.StackProps {
  stage: 'dev' | 'stg' | 'prd';
}

export class AfroGoApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { stage } = props;
    const name = (suffix: string) => `afrogo-${stage}-${suffix}`;
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    // Network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Aurora Postgres (Serverless v2)
    const dbCredentials = rds.Credentials.fromGeneratedSecret('postgres');
    const db = new rds.DatabaseCluster(this, 'Aurora', {
      // af-south-1 supports 15.10; use explicit version string to avoid unavailable defaults
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.of('15.10', '15') }),
      credentials: dbCredentials,
      defaultDatabaseName: 'afrogo',
      clusterIdentifier: name('aurora'),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      serverlessV2MinCapacity: 2,
      serverlessV2MaxCapacity: 8,
      backup: { retention: cdk.Duration.days(7) },
      enableDataApi: true,
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    const dbSecret = dbCredentials.secret ?? db.secret;

    // DynamoDB tables
    const routesTable = new dynamodb.Table(this, 'RoutesTable', {
      tableName: name('routes'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    routesTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: name('payout-audit'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const invoicesTable = new dynamodb.Table(this, 'InvoicesTable', {
      tableName: name('invoices'),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    invoicesTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Buckets
    const invoicesBucket = new s3.Bucket(this, 'InvoicesBucket', {
      bucketName: name('invoices'),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== 'prd',
    });

    // Queues / Topics
    const opsQueue = new sqs.Queue(this, 'OpsReviewQueue', {
      queueName: name('ops-review'),
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.seconds(120),
    });
    const notificationsQueue = new sqs.Queue(this, 'NotificationsQueue', {
      queueName: name('notifications'),
      retentionPeriod: cdk.Duration.days(14),
    });
    const analyticsQueue = new sqs.Queue(this, 'AnalyticsQueue', {
      queueName: name('analytics'),
      retentionPeriod: cdk.Duration.days(14),
    });
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', { topicName: name('alerts') });

    // Cognito
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: name('users'),
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireUppercase: true,
        requireLowercase: true,
        requireSymbols: true,
      },
      removalPolicy: stage === 'prd' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    const userPoolClient = userPool.addClient('UserPoolClient', { authFlows: { userPassword: true } });

    // Lambda helper
    const mkLambda = (id: string, serviceDir: string, env: Record<string, string> = {}) =>
      new lambda.Function(this, id, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(repoRoot, 'services', serviceDir, 'dist')),
        memorySize: 1024,
        timeout: cdk.Duration.seconds(60),
        tracing: lambda.Tracing.ACTIVE,
        vpc,
        environment: {
          AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
          AWS_XRAY_CONTEXT_MISSING: 'LOG_ERROR',
          REGION: 'af-south-1',
          ROUTES_TABLE_NAME: routesTable.tableName,
          AUDIT_TABLE_NAME: auditTable.tableName,
          INVOICES_TABLE_NAME: invoicesTable.tableName,
          INVOICES_BUCKET: invoicesBucket.bucketName,
          OPS_REVIEW_QUEUE_URL: opsQueue.queueUrl,
          NOTIFICATIONS_QUEUE_URL: notificationsQueue.queueUrl,
          ANALYTICS_QUEUE_URL: analyticsQueue.queueUrl,
          PG_SECRET_ARN: dbSecret?.secretArn ?? '',
          USER_POOL_ID: userPool.userPoolId,
          USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
          ...env,
        },
      });

    // Lambdas (artifacts expected under services/<svc>/dist)
    const routingGenerate = mkLambda('RoutingGenerate', 'routing-service');
    const payoutFinalize = mkLambda('PayoutFinalize', 'driver-service');
    const rateQuote = mkLambda('RateQuote', 'rate-engine', { AUDIT_TABLE_NAME: auditTable.tableName });
    const billingWebhook = mkLambda('BillingWebhook', 'billing-service', {
      INVOICES_BUCKET: invoicesBucket.bucketName,
    });
    const opsApi = mkLambda('OpsApi', 'ops-service');
    const notificationsWorker = mkLambda('NotificationsWorker', 'notification-service');

    // Permissions
    routesTable.grantReadWriteData(routingGenerate);
    routesTable.grantReadWriteData(payoutFinalize);
    auditTable.grantReadWriteData(rateQuote);
    auditTable.grantReadWriteData(payoutFinalize);
    invoicesTable.grantReadWriteData(billingWebhook);
    invoicesBucket.grantReadWrite(billingWebhook);
    opsQueue.grantSendMessages(routingGenerate);
    notificationsQueue.grantConsumeMessages(notificationsWorker);
    analyticsQueue.grantConsumeMessages(rateQuote);
    alertsTopic.grantPublish(routingGenerate);
    dbSecret?.grantRead(routingGenerate);
    dbSecret?.grantRead(payoutFinalize);
    dbSecret?.grantRead(billingWebhook);
    dbSecret?.grantRead(opsApi);
    db.grantDataApiAccess(payoutFinalize);
    db.grantDataApiAccess(billingWebhook);
    db.grantDataApiAccess(opsApi);

    // API Gateway (OpenAPI-aligned paths)
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: name('api'),
      deployOptions: {
        stageName: 'v1',
        throttlingBurstLimit: 500,
        throttlingRateLimit: 200,
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
      },
    });

    const add = (path: string, method: string, fn: lambda.Function, authorizer?: apigw.IAuthorizer) => {
      const res = api.root.resourceForPath(path);
      res.addMethod(method, new apigw.LambdaIntegration(fn), {
        authorizationType: authorizer ? apigw.AuthorizationType.COGNITO : apigw.AuthorizationType.NONE,
        authorizer,
      });
    };

    const cognitoAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', {
      cognitoUserPools: [userPool],
    });

    add('/routing/routes:generate', 'POST', routingGenerate, cognitoAuthorizer);
    add('/rate/quote-route', 'POST', rateQuote, cognitoAuthorizer);
    add('/drivers/{driverId}/routes/{routeId}/finalize', 'POST', payoutFinalize, cognitoAuthorizer);
    add('/billing/webhook', 'POST', billingWebhook);
    add('/ops/payouts/pending-review', 'GET', opsApi, cognitoAuthorizer);
    add('/ops/payouts/{payoutId}/approve', 'POST', opsApi, cognitoAuthorizer);
    add('/ops/payouts/{payoutId}/topup', 'POST', opsApi, cognitoAuthorizer);

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url ?? 'unknown' });
    new cdk.CfnOutput(this, 'Region', { value: cdk.Stack.of(this).region });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'RoutesTableName', { value: routesTable.tableName });
    new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
    new cdk.CfnOutput(this, 'InvoicesTableName', { value: invoicesTable.tableName });
    new cdk.CfnOutput(this, 'InvoicesBucketName', { value: invoicesBucket.bucketName });
    new cdk.CfnOutput(this, 'OpsQueueUrlOutput', { value: opsQueue.queueUrl });
  }
}
