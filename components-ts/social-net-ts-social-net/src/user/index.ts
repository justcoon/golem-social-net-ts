import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';

import { getOppositeConnectionType, UserConnectionType, Timestamp } from '../common/types';
import { serialize, deserialize } from '../common/snapshot';
import { getCurrentTimestamp } from '../common/utils';
import { Query, parseQuery, optTextMatches, textExactMatches } from '../common/query';
import { arrayChunks } from '../common/utils';

export interface ConnectedUser {
    userId: string;
    connectionTypes: UserConnectionType[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface User {
    userId: string;
    name: string | null;
    email: string | null;
    connectedUsers: [string, ConnectedUser][];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserIndexState {
    userIds: string[];
    updatedAt: Timestamp;
}

export function initUserState(userId: string, now: Timestamp): User {
    return {
        userId,
        name: null,
        email: null,
        connectedUsers: [],
        createdAt: now,
        updatedAt: now
    };
}

export function initUserIndexState(): UserIndexState {
    const now = getCurrentTimestamp();
    return {
        userIds: [],
        updatedAt: now
    };
}

export function setUserAgentName(user: User, name: string | null, now: Timestamp): void {
    user.name = name;
    user.updatedAt = now;
}

export function setUserAgentEmail(user: User, email: string | null, now: Timestamp): Result<null, string> {
    if (email !== null) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return Result.err(`Invalid email`);
        }
    }
    user.email = email;
    user.updatedAt = now;
    return Result.ok(null);
}

export function connectUserAgent(user: User, userId: string, connectionType: UserConnectionType, now: Timestamp): boolean {
    if (userId === user.userId) {
        return false;
    }

    let existingIdx = user.connectedUsers.findIndex(u => u[0] === userId);
    let existingConnection = existingIdx !== -1 ? user.connectedUsers[existingIdx]![1] : undefined;

    let shouldConnect = !existingConnection || !existingConnection.connectionTypes.includes(connectionType);

    if (shouldConnect) {
        if (existingConnection) {
            existingConnection.connectionTypes.push(connectionType);
            existingConnection.updatedAt = now;
        } else {
            user.connectedUsers.push([userId, {
                userId: userId,
                connectionTypes: [connectionType],
                createdAt: now,
                updatedAt: now
            }]);
        }
        user.updatedAt = now;
        return true;
    }
    return false;
}

export function disconnectUserAgent(user: User, userId: string, connectionType: UserConnectionType, now: Timestamp): boolean {
    if (userId === user.userId) {
        return false;
    }

    let existingIdx = user.connectedUsers.findIndex(u => u[0] === userId);
    let existingConnection = existingIdx !== -1 ? user.connectedUsers[existingIdx]![1] : undefined;

    let shouldDisconnect = existingConnection !== undefined && existingConnection.connectionTypes.includes(connectionType);

    if (shouldDisconnect) {
        if (existingConnection!.connectionTypes.length === 1) {
            user.connectedUsers.splice(existingIdx, 1);
        } else {
            existingConnection!.connectionTypes = existingConnection!.connectionTypes.filter(c => c !== connectionType);
            existingConnection!.updatedAt = now;
        }
        user.updatedAt = now;
        return true;
    }
    return false;
}

@agent()
export class UserAgent extends BaseAgent {
    private readonly _id: string;
    private state: User | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): User {
        if (this.state === null) {
            this.state = initUserState(this._id, getCurrentTimestamp());
            // Add user ID to index when user is created
            UserIndexAgent.get().add.trigger(this._id);
        }
        return this.state;
    }

    @prompt("Get the user details")
    @description("Returns the user details")
    async getUser(): Promise<User | null> {
        return this.state;
    }

    @prompt("Set the user name")
    @description("Sets the user name")
    async setName(name: string | null): Promise<Result<null, string>> {
        console.log(`set name: ${name ?? "N/A"}`);
        setUserAgentName(this.getState(), name, getCurrentTimestamp());
        return Result.ok(null);
    }

    @prompt("Set the user email")
    @description("Sets the user email")
    async setEmail(email: string | null): Promise<Result<null, string>> {
        console.log(`set email: ${email ?? "N/A"}`);
        return setUserAgentEmail(this.getState(), email, getCurrentTimestamp());
    }

    @prompt("Connect with a user")
    @description("Connects with a given user via a connection type")
    async connectUser(userId: string, connectionType: UserConnectionType): Promise<Result<null, string>> {
        const state = this.getState();
        const updated = connectUserAgent(state, userId, connectionType, getCurrentTimestamp());
        if (updated) {
            console.log(`connect user - id: ${userId}, type: ${connectionType}`);
            UserAgent.get(userId).connectUser.trigger(state.userId, getOppositeConnectionType(connectionType));
        } else {
            console.log(`connect user - id: ${userId}, type: ${connectionType} - connection already exists or invalid`);
        }
        return Result.ok(null);
    }

    @prompt("Disconnect a user")
    @description("Disconnects connection with a user")
    async disconnectUser(userId: string, connectionType: UserConnectionType): Promise<Result<null, string>> {
        const state = this.getState();
        const updated = disconnectUserAgent(state, userId, connectionType, getCurrentTimestamp());
        if (updated) {
            console.log(`disconnect user - id: ${userId}, type: ${connectionType}`);
            UserAgent.get(userId).disconnectUser.trigger(state.userId, getOppositeConnectionType(connectionType));
        } else {
            console.log(`disconnect user - id: ${userId}, type: ${connectionType} - connection not found or invalid`);
        }
        return Result.ok(null);
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<User>(bytes);
            this.state = raw;
        }
    }
}

@agent()
export class UserIndexAgent extends BaseAgent {
    private state: UserIndexState;

    constructor() {
        super();
        this.state = initUserIndexState();
    }

    @prompt("Add user ID to index")
    @description("Adds a user ID to the user index")
    async add(userId: string): Promise<void> {
        console.log(`Adding user ID to index: ${userId}`);
        if (!this.state.userIds.includes(userId)) {
            this.state.userIds.push(userId);
            this.state.updatedAt = getCurrentTimestamp();
        }
    }

    @prompt("Get user index state")
    @description("Returns the current state of the user index")
    async getState(): Promise<UserIndexState> {
        return this.state;
    }
}

class UserQueryMatcher {
    public readonly query: Query;

    constructor(queryStr: string) {
        this.query = parseQuery(queryStr);
    }

    public matches(user: User): boolean {
        for (const [field, value] of this.query.fieldFilters) {
            let matches = false;
            switch (field.toLowerCase()) {
                case "user-id":
                case "userid":
                    matches = textExactMatches(user.userId, value);
                    break;
                case "name":
                    matches = optTextMatches(user.name, value);
                    break;
                case "email":
                    matches = optTextMatches(user.email, value);
                    break;
                case "connected-users":
                case "connectedusers":
                    matches = user.connectedUsers.some((u) => textExactMatches(u[0], value));
                    break;
                default:
                    matches = false;
            }
            if (!matches) {
                return false;
            }
        }

        return this.query.terms.length === 0 || this.query.terms.some((term: string) =>
            textExactMatches(user.userId, term) ||
            optTextMatches(user.name, term) ||
            optTextMatches(user.email, term)
        );
    }
}

@agent({ mode: "ephemeral" })
export class UserSearchAgent extends BaseAgent {
    @prompt("Search users")
    @description("Searches for users using UserIndexAgent")
    async search(query: string): Promise<User[]> {
        console.log("Search users - query: " + query);
        const matcher = new UserQueryMatcher(query);

        const result: User[] = [];
        const processedIds = new Set<string>();

        // Get user IDs from UserIndexAgent
        const userIndex = UserIndexAgent.get();
        const userIndexState = await userIndex.getState();
        const userIds = userIndexState.userIds;

        if (userIds.length > 0) {
            const idsChunks = arrayChunks(userIds, 5);

            for (const ids of idsChunks) {
                console.log("Search users - ids: (" + ids + ")");

                const promises = ids.map(async (id) => await UserAgent.get(id).getUser());
                const promisesResult = await Promise.all(promises);

                for (const value of promisesResult) {
                    if (value) {
                        processedIds.add(value.userId);
                        if (matcher.matches(value)) {
                            result.push(value);
                        }
                    }
                }
            }
        }

        return result;
    }
}

