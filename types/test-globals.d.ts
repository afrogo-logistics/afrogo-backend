// Minimal test globals for unit tests so tsc won't error when @types/jest is not installed
declare const describe: any;
declare const it: any;
declare const test: any;
declare const expect: any;
declare function beforeEach(fn: any): void;
declare function afterEach(fn: any): void;
