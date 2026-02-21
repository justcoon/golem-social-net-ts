export function optTextMatches(text: string | null | undefined, query: string): boolean {
    return query === "*" || (text !== null && text !== undefined && text.toLowerCase().includes(query.toLowerCase()));
}

export function optTextExactMatches(text: string | null | undefined, query: string): boolean {
    return query === "*" || (text !== null && text !== undefined && text === query);
}

export function textMatches(text: string, query: string): boolean {
    return query === "*" || text.toLowerCase().includes(query.toLowerCase());
}

export function textExactMatches(text: string, query: string): boolean {
    return query === "*" || text === query;
}

export function tokenize(query: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const c of query) {
        if (c === " " && !inQuotes) {
            if (current.length > 0) {
                tokens.push(current.trim());
                current = "";
            }
        } else if (c === '"') {
            inQuotes = !inQuotes;
        } else {
            current += c;
        }
    }

    if (current.length > 0) {
        tokens.push(current.trim());
    }

    return tokens;
}

export class Query {
    public readonly terms: string[];
    public readonly fieldFilters: [string, string][];

    constructor(query: string) {
        this.terms = [];
        this.fieldFilters = [];

        const tokens = tokenize(query);

        for (const part of tokens) {
            const splitIndex = part.indexOf(':');
            if (splitIndex !== -1) {
                const field = part.substring(0, splitIndex).toLowerCase();
                const value = part.substring(splitIndex + 1);
                this.fieldFilters.push([field, value]);
            } else {
                this.terms.push(part);
            }
        }
    }

    public toString(): string {
        return `Query(terms: ${JSON.stringify(this.terms)}, fieldFilters: ${JSON.stringify(this.fieldFilters)})`;
    }
}
