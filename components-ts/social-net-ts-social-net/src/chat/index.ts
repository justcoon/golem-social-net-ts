import {
  BaseAgent,
  Result,
  agent,
  prompt,
  description,
} from "@golemcloud/golem-ts-sdk";
import { v4 as uuidv4 } from "uuid";

import { LikeType, Timestamp } from "../common/types";
import { serialize, deserialize } from "../common/snapshot";
import { getCurrentTimestamp } from "../common/utils";
import { Query, optTextMatches, textExactMatches } from "../common/query";
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

function executeChatUpdates(
  chatId: string,
  participantsIds: string[],
  updatedAt: Timestamp,
) {
  for (const pId of participantsIds) {
    UserChatsAgent.get(pId).chatUpdated.trigger(chatId, updatedAt);
  }
}

function executeAddChat(
  chatId: string,
  createdBy: string,
  createdAt: Timestamp,
  participantsIds: string[],
) {
  for (const pId of participantsIds) {
    if (pId !== createdBy) {
      UserChatsAgent.get(pId).addChat.trigger(chatId, createdBy, createdAt);
    }
  }
}

export function initChatState(chatId: string, now: Timestamp): Chat {
  return {
    chatId,
    createdBy: "",
    participants: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function initializeChatAgent(
  chat: Chat,
  participantsIds: string[],
  createdBy: string,
  createdAt: Timestamp,
): void {
  const pSet = new Set(participantsIds);
  pSet.add(createdBy);
  chat.createdBy = createdBy;
  chat.participants = Array.from(pSet);
  chat.createdAt = createdAt;
  chat.updatedAt = createdAt;
}

export function addChatParticipants(
  chat: Chat,
  participantsIds: string[],
  now: Timestamp,
): string[] {
  const existingSet = new Set(chat.participants);
  const newParticipants = participantsIds.filter((id) => !existingSet.has(id));

  if (newParticipants.length > 0) {
    chat.participants.push(...newParticipants);
    chat.updatedAt = now;
  }
  return newParticipants;
}

export function addChatMessage(
  chat: Chat,
  userId: string,
  content: string,
  now: Timestamp,
): Result<Message, string> {
  if (chat.messages.length >= MAX_CHAT_LENGTH) {
    return Result.err("Max chat length");
  } else {
    const message: Message = {
      messageId: uuidv4(),
      content: content,
      likes: [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    chat.updatedAt = message.createdAt;
    chat.messages.push(message);
    return Result.ok(message);
  }
}

export function removeChatMessage(
  chat: Chat,
  messageId: string,
  now: Timestamp,
): boolean {
  const initialLength = chat.messages.length;
  chat.messages = chat.messages.filter((m) => m.messageId !== messageId);

  if (chat.messages.length !== initialLength) {
    chat.updatedAt = now;
    return true;
  }
  return false;
}

export function setChatMessageLike(
  chat: Chat,
  messageId: string,
  userId: string,
  likeType: LikeType,
  now: Timestamp,
): boolean {
  const msg = chat.messages.find((m) => m.messageId === messageId);
  if (msg) {
    msg.likes = msg.likes.filter((l) => l[0] !== userId);
    msg.likes.push([userId, likeType]);
    msg.updatedAt = now;
    chat.updatedAt = now;
    return true;
  }
  return false;
}

export function removeChatMessageLike(
  chat: Chat,
  messageId: string,
  userId: string,
  now: Timestamp,
): boolean {
  const msg = chat.messages.find((m) => m.messageId === messageId);
  if (msg) {
    const initialLikes = msg.likes.length;
    msg.likes = msg.likes.filter((l) => l[0] !== userId);
    if (msg.likes.length !== initialLikes) {
      msg.updatedAt = now;
      chat.updatedAt = now;
      return true;
    }
  }
  return false;
}

export function matchesQuery(chat: Chat, query: Query): boolean {
  for (const [field, value] of query.fieldFilters) {
    let matches = false;
    switch (field.toLowerCase()) {
      case "chat-id":
      case "chatid":
        matches = textExactMatches(chat.chatId, value);
        break;
      case "created-by":
      case "createdby":
        matches = textExactMatches(chat.createdBy, value);
        break;
      case "participants":
        matches = chat.participants.some((p) => textExactMatches(p, value));
        break;
      default:
        matches = false;
    }
    if (!matches) {
      return false;
    }
  }

  return (
    query.terms.length === 0 ||
    query.terms.some(
      (term: string) =>
        textExactMatches(chat.chatId, term) ||
        textExactMatches(chat.createdBy, term) ||
        chat.participants.some((p) => textExactMatches(p, term)),
    )
  );
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
      this.state = initChatState(this._id, getCurrentTimestamp());
    }
    return this.state;
  }

  @prompt("Get the chat")
  @description("Returns the chat details")
  async getChat(): Promise<Chat | null> {
    return this.state;
  }

  @prompt("Get chat if matches query")
  @description("Returns the chat if it matches the query, null otherwise")
  async getChatIfMatch(query: Query): Promise<Chat | null> {
    return this.state && matchesQuery(this.state, query) ? this.state : null;
  }

  @prompt("Initialize the chat")
  @description("Initializes a new chat with participants")
  async initChat(
    participantsIds: string[],
    createdBy: string,
    createdAt: Timestamp,
  ): Promise<Result<null, string>> {
    if (this.state !== null) {
      return Result.err("Chat already exists");
    }

    const pSet = new Set(participantsIds);
    pSet.add(createdBy);
    const uniqueParticipants = Array.from(pSet);

    if (uniqueParticipants.length < 2) {
      return Result.err("Chat must have at least 2 participants");
    }

    const state = this.getState();
    console.log(
      `init chat - created by: ${createdBy}, participants: ${uniqueParticipants.length}`,
    );

    initializeChatAgent(state, participantsIds, createdBy, createdAt);

    executeAddChat(
      state.chatId,
      createdBy,
      state.createdAt,
      state.participants,
    );
    return Result.ok(null);
  }

  @prompt("Add chat participants")
  @description("Adds new participants to the chat")
  async addParticipants(
    participantsIds: string[],
  ): Promise<Result<null, string>> {
    if (this.state === null) {
      return Result.err("Chat not exists");
    }

    const state = this.getState();
    const oldParticipants = [...state.participants];
    const newParticipants = addChatParticipants(
      state,
      participantsIds,
      getCurrentTimestamp(),
    );

    if (newParticipants.length === 0) {
      return Result.err("No new participants");
    } else {
      console.log(
        `add participants - new participants: ${newParticipants.length}`,
      );

      executeAddChat(
        state.chatId,
        state.createdBy,
        state.updatedAt,
        newParticipants,
      );
      executeChatUpdates(state.chatId, oldParticipants, state.updatedAt);

      return Result.ok(null);
    }
  }

  @prompt("Add a chat message")
  @description("Adds a new message to the chat")
  async addMessage(
    userId: string,
    content: string,
  ): Promise<Result<string, string>> {
    if (this.state === null) {
      return Result.err("Chat not exists");
    }

    const state = this.getState();
    console.log(`add message - user id: ${userId}, content: ${content}`);

    const result = addChatMessage(
      state,
      userId,
      content,
      getCurrentTimestamp(),
    );
    if (result.isOk()) {
      executeChatUpdates(state.chatId, state.participants, state.updatedAt);
      return Result.ok(result.val.messageId);
    } else {
      return result;
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

    const updated = removeChatMessage(state, messageId, getCurrentTimestamp());
    if (updated) {
      executeChatUpdates(state.chatId, state.participants, state.updatedAt);
      return Result.ok(null);
    } else {
      return Result.err("Message not found");
    }
  }

  @prompt("Set like on a message")
  @description("Sets a like for a chat message")
  async setMessageLike(
    messageId: string,
    userId: string,
    likeType: LikeType,
  ): Promise<Result<null, string>> {
    if (this.state === null) {
      return Result.err("Chat not exists");
    }

    const state = this.getState();
    console.log(
      `set message like - message id: ${messageId}, user id: ${userId}, like type: ${likeType}`,
    );

    const updated = setChatMessageLike(
      state,
      messageId,
      userId,
      likeType,
      getCurrentTimestamp(),
    );
    if (updated) {
      executeChatUpdates(state.chatId, state.participants, state.updatedAt);
      return Result.ok(null);
    } else {
      return Result.err("Message not found");
    }
  }

  @prompt("Remove like from a message")
  @description("Removes a like from a chat message")
  async removeMessageLike(
    messageId: string,
    userId: string,
  ): Promise<Result<null, string>> {
    if (this.state === null) {
      return Result.err("Chat not exists");
    }

    const state = this.getState();
    console.log(
      `remove message like - chat id: ${messageId}, user id: ${userId}`,
    );

    const updated = removeChatMessageLike(
      state,
      messageId,
      userId,
      getCurrentTimestamp(),
    );
    if (updated) {
      executeChatUpdates(state.chatId, state.participants, state.updatedAt);
      return Result.ok(null);
    } else {
      return Result.err("Message not found");
    }
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
