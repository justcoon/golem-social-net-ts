import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';
import { v4 as uuidv4 } from 'uuid';

import { LikeType, Timestamp } from '../common/types';
import { serialize, deserialize } from '../common/snapshot';
import { getCurrentTimestamp } from '../common/utils';
import { UserChatsAgent } from "../user-chats";

const MAX_CHAT_LENGTH = 2000;

export interface Message {
    messageId: string;
    content: string;
    likes: [string, LikeType][];
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface Chat {
    chatId: string;
    createdBy: string;
    participants: string[];
    messages: Message[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

function executeChatUpdates(chatId: string, participantsIds: string[], updatedAt: Timestamp) {
    for (const pId of participantsIds) {
        UserChatsAgent.get(pId).chatUpdated.trigger(chatId, updatedAt);
    }
}

function executeAddChat(chatId: string, createdBy: string, createdAt: Timestamp, participantsIds: string[]) {
    for (const pId of participantsIds) {
        if (pId !== createdBy) {
            UserChatsAgent.get(pId).addChat.trigger(chatId, createdBy, createdAt);
        }
    }
}

@agent()
export class ChatAgent extends BaseAgent {
    private readonly _id: string;
    private state: Chat | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): Chat {
        if (this.state === null) {
            const now = getCurrentTimestamp();
            this.state = {
                chatId: this._id,
                createdBy: "",
                participants: [],
                messages: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Get the chat")
    @description("Returns the chat details")
    async getChat(): Promise<Chat | null> {
        return this.state;
    }

    @prompt("Initialize the chat")
    @description("Initializes a new chat with participants")
    async initChat(participantsIds: string[], createdBy: string, createdAt: Timestamp): Promise<Result<null, string>> {
        const pSet = new Set(participantsIds);
        pSet.add(createdBy);
        const uniqueParticipants = Array.from(pSet);

        if (this.state !== null) {
            return Result.err("Chat already exists");
        } else if (uniqueParticipants.length < 2) {
            return Result.err("Chat must have at least 2 participants");
        } else {
            const state = this.getState();
            console.log(`init chat - created by: ${createdBy}, participants: ${uniqueParticipants.length}`);
            state.createdBy = createdBy;
            state.participants = uniqueParticipants;
            state.createdAt = createdAt;
            state.updatedAt = createdAt;

            executeAddChat(state.chatId, createdBy, state.createdAt, state.participants);
            return Result.ok(null);
        }
    }

    @prompt("Add chat participants")
    @description("Adds new participants to the chat")
    async addParticipants(participantsIds: string[]): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Chat not exists");
        }

        const state = this.getState();
        const existingSet = new Set(state.participants);
        const newParticipants = participantsIds.filter(id => !existingSet.has(id));

        if (newParticipants.length === 0) {
            return Result.err("No new participants");
        } else {
            console.log(`add participants - new participants: ${newParticipants.length}`);
            const oldParticipants = [...state.participants];

            state.participants.push(...newParticipants);
            state.updatedAt = getCurrentTimestamp();

            executeAddChat(state.chatId, state.createdBy, state.updatedAt, newParticipants);
            executeChatUpdates(state.chatId, oldParticipants, state.updatedAt);

            return Result.ok(null);
        }
    }

    @prompt("Add a chat message")
    @description("Adds a new message to the chat")
    async addMessage(userId: string, content: string): Promise<Result<string, string>> {
        if (this.state === null) {
            return Result.err("Chat not exists");
        }

        const state = this.getState();
        console.log(`add message - user id: ${userId}, content: ${content}`);

        if (state.messages.length >= MAX_CHAT_LENGTH) {
            return Result.err("Max chat length");
        } else {
            const now = getCurrentTimestamp();
            const message: Message = {
                messageId: uuidv4(),
                content: content,
                likes: [],
                createdBy: userId,
                createdAt: now,
                updatedAt: now
            };

            state.updatedAt = message.createdAt;
            state.messages.push(message);

            executeChatUpdates(state.chatId, state.participants, state.updatedAt);
            return Result.ok(message.messageId);
        }
    }

    @prompt("Remove a chat message")
    @description("Removes a message from the chat")
    async removeMessage(messageId: string): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Chat not exists");
        }

        const state = this.getState();
        console.log(`remove message - message id: ${messageId}`);

        const initialLength = state.messages.length;
        state.messages = state.messages.filter(m => m.messageId !== messageId);

        if (state.messages.length !== initialLength) {
            state.updatedAt = getCurrentTimestamp();
            executeChatUpdates(state.chatId, state.participants, state.updatedAt);
            return Result.ok(null);
        } else {
            return Result.err("Message not found");
        }
    }

    @prompt("Set like on a message")
    @description("Sets a like for a chat message")
    async setMessageLike(messageId: string, userId: string, likeType: LikeType): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Chat not exists");
        }

        const state = this.getState();
        console.log(`set message like - message id: ${messageId}, user id: ${userId}, like type: ${likeType}`);

        const msg = state.messages.find(m => m.messageId === messageId);
        if (msg) {
            msg.likes = msg.likes.filter(l => l[0] !== userId);
            msg.likes.push([userId, likeType]);
            const now = getCurrentTimestamp();
            msg.updatedAt = now;
            state.updatedAt = now;

            executeChatUpdates(state.chatId, state.participants, state.updatedAt);
            return Result.ok(null);
        } else {
            return Result.err("Message not found");
        }
    }

    @prompt("Remove like from a message")
    @description("Removes a like from a chat message")
    async removeMessageLike(messageId: string, userId: string): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Chat not exists");
        }

        const state = this.getState();
        console.log(`remove message like - chat id: ${messageId}, user id: ${userId}`);

        const msg = state.messages.find(m => m.messageId === messageId);
        if (msg) {
            const initialLikes = msg.likes.length;
            msg.likes = msg.likes.filter(l => l[0] !== userId);
            if (msg.likes.length !== initialLikes) {
                const now = getCurrentTimestamp();
                msg.updatedAt = now;
                state.updatedAt = now;
                executeChatUpdates(state.chatId, state.participants, state.updatedAt);
                return Result.ok(null);
            }
        }
        return Result.err("Message not found");
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<Chat>(bytes);
            this.state = raw;
        }
    }
}
