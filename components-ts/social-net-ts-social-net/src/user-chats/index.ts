import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';

import { Query, optTextExactMatches, textExactMatches, textMatches } from '../common/query';
import { serialize, deserialize } from '../common/snapshot';
import { Timestamp } from '../common/types';
import { getCurrentTimestamp } from '../common/utils';
import { pollForUpdates } from '../common/poll';
import { arrayChunks } from '../common/utils';
import { Chat, ChatAgent } from '../chat/index';

const CHATS_MAX_COUNT = 500;

export interface ChatRef {
    chatId: string;
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserChats {
    userId: string;
    chats: ChatRef[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserChatsUpdates {
    userId: string;
    chats: ChatRef[];
}

@agent()
export class UserChatsAgent extends BaseAgent {
    private readonly _id: string;
    private state: UserChats | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): UserChats {
        if (this.state === null) {
            const now = getCurrentTimestamp();
            this.state = {
                userId: this._id,
                chats: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Get chats")
    @description("Returns the chats for the user")
    async getChats(): Promise<UserChats | null> {
        return this.state;
    }

    @prompt("Create chat")
    @description("Creates a new chat")
    async createChat(participantsIds: string[]): Promise<Result<string, string>> {
        const state = this.getState();
        const chatId = crypto.randomUUID();
        console.log(`create chat - chat id: ${chatId}, created by: ${state.userId}, participants: ${participantsIds.length}`);

        const now = getCurrentTimestamp();
        const chatRef: ChatRef = {
            chatId,
            createdBy: state.userId,
            createdAt: now,
            updatedAt: now
        };

        state.updatedAt = now;
        state.chats.push(chatRef);
        state.chats.sort((a, b) => b.updatedAt.timestamp.localeCompare(a.updatedAt.timestamp));

        if (state.chats.length > CHATS_MAX_COUNT) {
            state.chats = state.chats.slice(0, CHATS_MAX_COUNT);
        }

        // Trigger chat initialization
        ChatAgent.get(chatId).initChat.trigger(participantsIds, state.userId, now);

        return Result.ok(chatId);
    }

    @prompt("Get updates")
    @description("Returns chat updates since a given time")
    async getUpdates(updatesSince: Timestamp): Promise<UserChatsUpdates | null> {
        if (this.state !== null) {
            console.log(`get updates - updates since: ${updatesSince.timestamp}`);
            const since = updatesSince;

            const updates = this.state.chats.filter(c => c.updatedAt.timestamp > since.timestamp);
            return {
                userId: this.state.userId,
                chats: updates
            };
        }
        return null;
    }

    @prompt("Chat updated")
    @description("Triggered when a chat is updated")
    async chatUpdated(chatId: string, updatedAt: Timestamp): Promise<Result<null, string>> {
        const state = this.getState();
        console.log(`chat updated - chat id: ${chatId}, updated at: ${updatedAt.timestamp}`);

        const chatIdx = state.chats.findIndex(c => c.chatId === chatId);
        if (chatIdx !== -1) {
            state.chats[chatIdx]!.updatedAt = updatedAt;
            state.chats.sort((a, b) => b.updatedAt.timestamp.localeCompare(a.updatedAt.timestamp));
            state.updatedAt = getCurrentTimestamp();
            return Result.ok(null);
        } else {
            console.log(`chat updated - chat id: ${chatId} - chat not found`);
            return Result.err("Chat not found");
        }
    }

    @prompt("Add chat")
    @description("Triggered when a new chat is added to the user's list")
    async addChat(chatId: string, createdBy: string, createdAt: Timestamp): Promise<Result<null, string>> {
        const state = this.getState();
        console.log(`add chat - chat id: ${chatId}, created by: ${createdBy}, created at: ${createdAt.timestamp}`);

        if (!state.chats.find(c => c.chatId === chatId)) {
            state.chats.push({
                chatId,
                createdBy,
                createdAt: createdAt,
                updatedAt: getCurrentTimestamp()
            });

            state.chats.sort((a, b) => b.updatedAt.timestamp.localeCompare(a.updatedAt.timestamp));

            if (state.chats.length > CHATS_MAX_COUNT) {
                state.chats = state.chats.slice(0, CHATS_MAX_COUNT);
            }
            state.updatedAt = getCurrentTimestamp();
        }
        return Result.ok(null);
    }

    @prompt("Remove chat")
    @description("Triggered when a chat is removed from the user's list")
    async removeChat(chatId: string): Promise<Result<null, string>> {
        const state = this.getState();
        console.log(`remove chat - chat id: ${chatId}`);
        state.chats = state.chats.filter(c => c.chatId !== chatId);
        state.updatedAt = getCurrentTimestamp();
        return Result.ok(null);
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<UserChats>(bytes);
            if (raw) {
                this.state = raw;
            } else {
                this.state = null;
            }
        }
    }
}

async function fetchChatsByIds(chatIds: string[]): Promise<Chat[]> {
    const results: Chat[] = [];
    const chunks = arrayChunks(chatIds, 10);

    for (const chunk of chunks) {
        const promises = chunk.map(id => ChatAgent.get(id).getChat());
        const chatsOptions = await Promise.all(promises);
        for (const c of chatsOptions) {
            if (c) {
                results.push(c);
            }
        }
    }

    return results;
}

class ChatQueryMatcher {
    public readonly query: Query;

    constructor(queryStr: string) {
        this.query = new Query(queryStr);
    }

    public matchesChatRef(chatRef: ChatRef): boolean {
        for (const [field, value] of this.query.fieldFilters) {
            let matches = false;
            switch (field.toLowerCase()) {
                case "created-by":
                case "createdby":
                    matches = textExactMatches(chatRef.createdBy, value);
                    break;
                case "participants":
                case "content":
                    matches = true;
                    break;
                default:
                    matches = false;
            }
            if (!matches) {
                return false;
            }
        }
        return true;
    }

    public matchesChat(chat: Chat): boolean {
        for (const [field, value] of this.query.fieldFilters) {
            let matches = false;
            switch (field.toLowerCase()) {
                case "content":
                    matches = chat.messages.some(m => textMatches(m.content, value));
                    break;
                case "created-by":
                case "createdby":
                    matches = textExactMatches(chat.createdBy, value);
                    break;
                case "participants":
                    matches = chat.participants.some(p => textExactMatches(p, value));
                    break;
                default:
                    matches = false;
            }
            if (!matches) {
                return false;
            }
        }

        return this.query.terms.length === 0 || this.query.terms.some(term => {
            const matchesContent = chat.messages.some(m => textMatches(m.content, term));
            const matchesParticipants = chat.participants.some(p => textExactMatches(p, term));
            return matchesContent || matchesParticipants;
        });
    }
}

@agent({ mode: "ephemeral" })
export class UserChatsViewAgent extends BaseAgent {
    constructor() {
        super();
    }

    @prompt("Get chats view")
    @description("Returns fetched and filtered chats")
    async getChatsView(userId: string, query: string): Promise<Chat[] | null> {
        const userChats = await UserChatsAgent.get(userId).getChats();

        console.log(`get chats view - user id: ${userId}, query: ${query}`);

        if (userChats !== null) {
            const queryMatcher = new ChatQueryMatcher(query);
            const chatRefs = userChats.chats;

            if (chatRefs.length === 0) {
                return [];
            } else {
                const validRefs = chatRefs.filter(p => queryMatcher.matchesChatRef(p));
                const chatIds = validRefs.map(p => p.chatId);
                const chats = await fetchChatsByIds(chatIds);

                return chats.filter(p => queryMatcher.matchesChat(p));
            }
        } else {
            return null;
        }
    }

    @prompt("Get chats updates view")
    @description("Returns updated fetched chats")
    async getChatsUpdatesView(userId: string, updatesSince: Timestamp): Promise<Chat[] | null> {
        const userChatsUpdates = await UserChatsAgent.get(userId).getUpdates(updatesSince);

        console.log(`get chats updates view - user id: ${userId}, updates since: ${updatesSince.timestamp}`);

        if (userChatsUpdates !== null) {
            const updatedChatRefs = userChatsUpdates.chats;

            if (updatedChatRefs.length === 0) {
                return [];
            } else {
                const chatIds = updatedChatRefs.map(p => p.chatId);
                return await fetchChatsByIds(chatIds);
            }
        } else {
            return null;
        }
    }
}

@agent({ mode: "ephemeral" })
export class UserChatsUpdatesAgent extends BaseAgent {
    constructor() {
        super();
    }

    @prompt("Get chats updates")
    @description("Polls and retrieves chat updates for a user")
    async getChatsUpdates(
        userId: string,
        updatesSince: Timestamp | null,
        iterWaitTime: number | null,
        maxWaitTime: number | null
    ): Promise<ChatRef[] | null> {
        const uSince = updatesSince ?? undefined;
        const iWait = iterWaitTime ?? undefined;
        const mWait = maxWaitTime ?? undefined;

        const res = await pollForUpdates<ChatRef>(
            userId,
            uSince,
            iWait,
            mWait,
            async (uid, since) => {
                const updates = await UserChatsAgent.get(uid).getUpdates(since);
                return updates ? updates.chats : undefined;
            },
            "get chats updates"
        );
        return res ?? null;
    }
}
