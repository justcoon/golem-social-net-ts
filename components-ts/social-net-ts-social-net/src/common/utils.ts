import { Timestamp } from "./types";
import { Md5 } from 'ts-md5';

export function arrayChunks<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }

  return chunks;
}

export function getCurrentTimestamp(): Timestamp {
  return {
    timestamp: new Date().toISOString().replace("Z", "000+00:00"),
  };
}

export function getShardNumber(id: string, numOfShards: number): number {
  const hash = Md5.hashStr(id);
  const hashInt = parseInt(hash.substring(0, 8), 16);
  return hashInt % numOfShards;
}
