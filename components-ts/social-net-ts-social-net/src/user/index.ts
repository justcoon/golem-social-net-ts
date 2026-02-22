import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
    GetAgents,
    AgentAnyFilter,
    getSelfMetadata
} from '@golemcloud/golem-ts-sdk';

import {ComponentId} from '@golemcloud/golem-ts-sdk';
import {getOppositeConnectionType, UserConnectionType, Timestamp} from '../common/types';
import {serialize, deserialize} from '../common/snapshot';
import {Query, optTextMatches, textExactMatches} from '../common/query';
import {arrayChunks, getCurrentTimestamp} from '../common/utils';

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
            const now = getCurrentTimestamp();
            this.state = {
                userId: this._id,
                name: null,
                email: null,
                connectedUsers: [],
                createdAt: now,
                updatedAt: now
            };
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
        const state = this.getState();
        state.name = name;
        state.updatedAt = getCurrentTimestamp();
        return Result.ok(null);
    }

    @prompt("Set the user email")
    @description("Sets the user email")
    async setEmail(email: string | null): Promise<Result<null, string>> {
        console.log(`set email: ${email ?? "N/A"}`);
        if (email !== null) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return Result.err(`Invalid email`);
            }
        }
        const state = this.getState();
        state.email = email;
        state.updatedAt = getCurrentTimestamp();
        return Result.ok(null);
    }

    @prompt("Connect with a user")
    @description("Connects with a given user via a connection type")
    async connectUser(userId: string, connectionType: UserConnectionType): Promise<Result<null, string>> {
        const state = this.getState();
        if (userId === state.userId) {
            console.log(`connect user - id: ${userId}, type: ${connectionType} - connection already exists or invalid`);
            return Result.ok(null);
        }

        let existingIdx = state.connectedUsers.findIndex(u => u[0] === userId);
        let existingConnection = existingIdx !== -1 ? state.connectedUsers[existingIdx]![1] : undefined;

        let shouldConnect = !existingConnection || !existingConnection.connectionTypes.includes(connectionType);

        if (shouldConnect) {
            console.log(`connect user - id: ${userId}, type: ${connectionType}`);
            const now = getCurrentTimestamp();
            if (existingConnection) {
                existingConnection.connectionTypes.push(connectionType);
                existingConnection.updatedAt = now;
            } else {
                state.connectedUsers.push([userId, {
                    userId: userId,
                    connectionTypes: [connectionType],
                    createdAt: now,
                    updatedAt: now
                }]);
            }
            state.updatedAt = now;

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
        if (userId === state.userId) {
            return Result.ok(null);
        }

        let existingIdx = state.connectedUsers.findIndex(u => u[0] === userId);
        let existingConnection = existingIdx !== -1 ? state.connectedUsers[existingIdx]![1] : undefined;

        let shouldDisconnect = existingConnection !== undefined && existingConnection.connectionTypes.includes(connectionType);

        if (shouldDisconnect) {
            console.log(`disconnect user - id: ${userId}, type: ${connectionType}`);
            const now = getCurrentTimestamp();
            if (existingConnection!.connectionTypes.length === 1) {
                state.connectedUsers.splice(existingIdx, 1);
            } else {
                existingConnection!.connectionTypes = existingConnection!.connectionTypes.filter(c => c !== connectionType);
                existingConnection!.updatedAt = now;
            }
            state.updatedAt = now;

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

class UserQueryMatcher {
    public readonly query: Query;

    constructor(queryStr: string) {
        this.query = new Query(queryStr);
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

const USER_AGENT_FILTER: AgentAnyFilter = {
    filters: [{
        filters: [
            {
                tag: "name",
                val: {
                    comparator: "starts-with",
                    value: "user-agent("
                }
            }
        ]
    }]
}

function getUserAgentId(agentName: string): string | undefined {
    // parseAgentId(agentName)
    const match = agentName.match(/^user-agent\("([^"]+)"\)$/);
    return match ? match[1] : undefined;
}


@agent({mode: "ephemeral"})
export class UserSearchAgent extends BaseAgent {
    private readonly componentId: ComponentId;

    constructor() {
        super();
        this.componentId = getSelfMetadata().agentId.componentId;
    }

    @prompt("Search users")
    @description("Searches for users using discovery")
    async search(query: string): Promise<Result<User[], string>> {
        console.log("Search users - query: " + query);
        const matcher = new UserQueryMatcher(query);

        const result: User[] = [];
        const processedIds = new Set<string>();

        const getter = new GetAgents(this.componentId, USER_AGENT_FILTER, true);
        let agents = await getter.getNext();

        while (agents && agents.length > 0) {

            const ids = agents.map((value) => getUserAgentId(value.agentId.agentId))
                .filter((id) => id !== undefined)
                .filter((id) => !processedIds.has(id));

            if (ids.length > 0) {
                const idsChunks = arrayChunks(ids, 5);

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

            agents = await getter.getNext();
        }

        return Result.ok(result);
    }
}
