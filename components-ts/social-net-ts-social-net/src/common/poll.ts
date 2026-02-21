export async function pollForUpdates<T>(
    userId: string,
    updatesSince: number | undefined,
    iterWaitTimeMs: number | undefined,
    maxWaitTimeMs: number | undefined,
    getUpdatesFn: (id: string, since: number) => Promise<T[] | undefined>,
    logPrefix: string
): Promise<T[] | undefined> {
    const since = updatesSince ?? Date.now();
    const maxWaitTime = maxWaitTimeMs ?? 10000;
    const iterWaitTime = iterWaitTimeMs ?? 1000;
    const startTime = Date.now();
    let done = false;
    let result: T[] | undefined = undefined;

    while (!done) {
        const elapsedTime = Date.now() - startTime;
        console.log(
            `${logPrefix} - user id: ${userId}, updates since: ${since.toString()}, elapsed time: ${elapsedTime}ms, max wait time: ${maxWaitTime}ms`
        );

        const res = await getUpdatesFn(userId, since);

        if (res !== undefined) {
            if (res.length > 0) {
                result = res;
                done = true;
            } else {
                result = [];
                done = (Date.now() - startTime) >= maxWaitTime;
                if (!done) {
                    await new Promise(resolve => setTimeout(resolve, iterWaitTime));
                }
            }
        } else {
            result = undefined;
            done = true;
        }
    }
    return result;
}
