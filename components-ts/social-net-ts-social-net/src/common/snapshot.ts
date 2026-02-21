export const SERIALIZATION_VERSION_V1 = 1;

export function serialize<T>(value: T): Uint8Array {
    const jsonData = JSON.stringify(value, null, 2);
    const dataBytes = new TextEncoder().encode(jsonData);

    const result = new Uint8Array(dataBytes.length + 1);
    result[0] = SERIALIZATION_VERSION_V1;
    result.set(dataBytes, 1);

    return result;
}

export function deserialize<T>(bytes: Uint8Array): T {
    if (bytes.length === 0) {
        throw new Error("Empty snapshot");
    }

    const version = bytes[0];

    if (version === SERIALIZATION_VERSION_V1) {
        const dataBytes = bytes.slice(1);
        const jsonData = new TextDecoder().decode(dataBytes);
        return JSON.parse(jsonData) as T;
    } else {
        throw new Error("Unsupported serialization version");
    }
}
