import 'aws-lambda';

declare module 'aws-lambda' {
  // Extend APIGateway V2 requestContext with authorizer and connectionId used across the repo.
  export interface APIGatewayEventRequestContextV2 {
    authorizer?: any;
    connectionId?: string;
  }
}
