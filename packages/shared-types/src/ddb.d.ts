export type DdbAttr = {
    S: string;
} | {
    N: string;
} | {
    BOOL: boolean;
} | {
    M: Record<string, DdbAttr>;
} | {
    L: DdbAttr[];
} | {
    NULL: true;
};
export type DdbItem = Record<string, DdbAttr>;
//# sourceMappingURL=ddb.d.ts.map