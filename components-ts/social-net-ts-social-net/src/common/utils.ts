import { Timestamp } from './types';

export function arrayChunks<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }

    return chunks;
}

export function getCurrentTimestamp(): Timestamp {
    return {
        timestamp: new Date().toISOString().replace('Z', '000+00:00')
    };
}
