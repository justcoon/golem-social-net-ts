import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';
import { v4 as uuidv4 } from 'uuid';

import { LikeType, Timestamp } from '../common/types';
import { Query, textExactMatches, textMatches } from '../common/query';
import { serialize, deserialize } from '../common/snapshot';
import { arrayChunks, getCurrentTimestamp } from '../common/utils';
import { UserAgent } from '../user/index';
import { PostRef, UserTimelineAgent } from '../user-timeline/index';

const MAX_COMMENTS_LENGTH = 2000;

export interface Comment {
    commentId: string;
    parentCommentId: string | null;
    content: string;
    likes: [string, LikeType][];
    createdBy: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface Post {
    postId: string;
    content: string;
    createdBy: string;
    likes: [string, LikeType][];
    comments: [string, Comment][];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export function matchesPost(post: Post, query: Query): boolean {
    // Check field filters first
    for (const [field, value] of query.fieldFilters) {
        let matches = false;
        switch (field.toLowerCase()) {
            case "created-by":
            case "createdby":
                matches = textExactMatches(post.createdBy, value);
                break;
            case "content":
                matches = textMatches(post.content, value);
                break;
            case "comments":
                matches = post.comments.some(([_, comment]) => textMatches(comment.content, value));
                break;
            default:
                matches = false;
        }
        if (!matches) {
            return false;
        }
    }

    return query.terms.length === 0 || query.terms.some(term => {
        const matchesContent = textMatches(post.content, term);
        const matchesComments = post.comments.some(([_, comment]) => textMatches(comment.content, term));
        return matchesContent || matchesComments;
    });
}

export interface PostUpdate {
    postId: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface PostUpdates {
    userId: string;
    updates: PostUpdate[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

@agent()
export class TimelinesUpdaterAgent extends BaseAgent {
    private readonly _id: string;
    private state: PostUpdates | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): PostUpdates {
        if (this.state === null) {
            const now = getCurrentTimestamp();
            this.state = {
                userId: this._id,
                updates: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Trigger post updated")
    @description("Trigger timelines update on post creation or modifications")
    async postUpdated(update: PostUpdate, processImmediately: boolean): Promise<void> {
        console.log(`timelines updater - user: ${this._id}, post: ${update.postId}`);
        const state = this.getState();

        // Add or update the queued update
        state.updates = state.updates.filter(u => u.postId !== update.postId);
        state.updates.push(update);
        state.updatedAt = getCurrentTimestamp();

        if (processImmediately) {
            await this.executePostsUpdates();
        }
    }

    @prompt("Process posts updates")
    @description("Processes all queued post updates")
    async processPostsUpdates(): Promise<void> {
        await this.executePostsUpdates();
    }

    private async executePostsUpdates(): Promise<void> {
        const state = this.getState();
        if (state.updates.length === 0) {
            return;
        }

        console.log(`posts updates - user id: ${this._id} - updates: ${state.updates.length} - processing ...`);

        const user = await UserAgent.get(this._id).getUser();
        if (user) {
            const updates = [...state.updates];
            state.updates = [];
            state.updatedAt = getCurrentTimestamp();

            const connectedUsers = user.connectedUsers;
            const postRefs: PostRef[] = updates.map(u => ({
                postId: u.postId,
                createdBy: this._id,
                createdByConnectionType: null,
                createdAt: u.createdAt,
                updatedAt: u.updatedAt
            }));

            // Update user's own timeline
            UserTimelineAgent.get(this._id).postsUpdated.trigger(postRefs);

            // Update connected users' timelines
            for (const cuTuple of connectedUsers) {
                const cu = cuTuple[1];
                for (const ct of cu.connectionTypes) {
                    const notifyPostRefs = updates.map(u => ({
                        postId: u.postId,
                        createdBy: this._id,
                        createdByConnectionType: ct,
                        createdAt: u.createdAt,
                        updatedAt: u.updatedAt
                    }));
                    UserTimelineAgent.get(cu.userId).postsUpdated.trigger(notifyPostRefs);
                }
            }
        } else {
            console.log(`posts updates - user id: ${this._id} - not found`);
        }
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<PostUpdates>(bytes);
            if (raw) {
                this.state = raw;
            }
        }
    }
}

@agent()
export class PostAgent extends BaseAgent {
    private readonly _id: string;
    private state: Post | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): Post {
        if (this.state === null) {
            const now = getCurrentTimestamp();
            this.state = {
                postId: this._id,
                content: "",
                createdBy: "",
                likes: [],
                comments: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Get the post")
    @description("Returns the post details")
    async getPost(): Promise<Post | null> {
        return this.state;
    }

    @prompt("Initialize the post")
    @description("Initializes a new post with content and author")
    async initPost(createdBy: string, content: string): Promise<Result<null, string>> {
        if (this.state !== null) {
            return Result.err("Post already exists");
        }

        const state = this.getState();
        console.log(`init post - created by: ${createdBy}, content: ${content} `);

        state.createdBy = createdBy;
        state.content = content;

        TimelinesUpdaterAgent.get(createdBy).postUpdated.trigger({
            postId: state.postId,
            createdAt: state.createdAt,
            updatedAt: state.createdAt
        }, true);

        return Result.ok(null);
    }

    @prompt("Set like on the post")
    @description("Sets a like for the post")
    async setLike(userId: string, likeType: LikeType): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Post not exists");
        }
        const state = this.getState();
        console.log(`set like - user id: ${userId}, like type: ${likeType}`);

        if (state) {
            state.likes = state.likes.filter(l => l[0] !== userId);
            state.likes.push([userId, likeType]);
            state.updatedAt = getCurrentTimestamp();
        }

        return Result.ok(null);
    }

    @prompt("Remove like from the post")
    @description("Removes a like from the post")
    async removeLike(userId: string): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Post not exists");
        }

        const state = this.getState();
        console.log(`remove like - user id: ${userId} `);

        const initialLength = state.likes.length;
        state.likes = state.likes.filter(l => l[0] !== userId);

        if (state && state.likes.length !== initialLength) {
            state.updatedAt = getCurrentTimestamp();
            return Result.ok(null);
        } else {
            return Result.err("Like not found");
        }
    }

    @prompt("Add a comment")
    @description("Adds a new comment to the post")
    async addComment(userId: string, content: string, parentCommentId: string | null): Promise<Result<string, string>> {
        if (this.state === null) {
            return Result.err("Post not exists");
        }

        const state = this.getState();
        console.log(`add comment - user id: ${userId}, content: ${content} `);

        if (state.comments.length >= MAX_COMMENTS_LENGTH) {
            return Result.err("Max comments limit reached");
        }

        const now = getCurrentTimestamp();
        const cid = uuidv4();

        state.comments.push([cid, {
            commentId: cid,
            parentCommentId,
            content,
            likes: [],
            createdBy: userId,
            createdAt: now,
            updatedAt: now
        }]);
        state.updatedAt = now;

        return Result.ok(cid);
    }

    @prompt("Remove a comment")
    @description("Removes a comment from the post")
    async removeComment(commentId: string): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Post not exists");
        }

        const state = this.getState();
        console.log(`remove comment - comment id: ${commentId} `);

        const initialLength = state.comments.length;
        state.comments = state.comments.filter(c => c[0] !== commentId && c[1].parentCommentId !== commentId);

        if (state.comments.length !== initialLength) {
            state.updatedAt = getCurrentTimestamp();
            return Result.ok(null);
        } else {
            return Result.err("Comment not found");
        }
    }

    @prompt("Set like on a comment")
    @description("Sets a like for a comment")
    async setCommentLike(commentId: string, userId: string, likeType: LikeType): Promise<Result<null, string>> {
        const state = this.getState();
        console.log(`set comment like - comment id: ${commentId}, user id: ${userId}, like type: ${likeType}`);

        const commentTuple = state.comments.find(c => c[0] === commentId);
        if (commentTuple) {
            const comment = commentTuple[1];
            comment.likes = comment.likes.filter(l => l[0] !== userId);
            comment.likes.push([userId, likeType]);
            comment.updatedAt = getCurrentTimestamp(); // Update comment's own timestamp
            state.updatedAt = getCurrentTimestamp(); // Update post's timestamp
            return Result.ok(null);
        } else {
            return Result.err("Comment not found");
        }
    }

    @prompt("Remove like from a comment")
    @description("Removes a like from a comment")
    async removeCommentLike(commentId: string, userId: string): Promise<Result<null, string>> {
        if (this.state === null) {
            return Result.err("Post not exists");
        }

        const state = this.getState();
        console.log(`remove comment like - comment id: ${commentId}, user id: ${userId} `);

        const cidx = state.comments.findIndex(c => c[0] === commentId);
        if (cidx !== -1) {
            const comment = state.comments[cidx]![1];
            const initialLikes = comment.likes.length;
            comment.likes = comment.likes.filter(l => l[0] !== userId);

            if (comment.likes.length !== initialLikes) {
                const now = getCurrentTimestamp();
                comment.updatedAt = now;
                state.updatedAt = now;
                return Result.ok(null);
            }
        }
        return Result.err("Comment not found");
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<Post>(bytes);
            if (raw) {
                this.state = raw;
            } else {
                this.state = null;
            }
        }
    }
}

export async function fetchPostsByIds(postIds: string[]): Promise<Post[]> {
    const results: Post[] = [];
    const chunks = arrayChunks(postIds, 10);

    for (const chunk of chunks) {
        const promises = chunk.map(id => PostAgent.get(id).getPost());
        const postsOptions = await Promise.all(promises);
        for (const p of postsOptions) {
            if (p) {
                results.push(p);
            }
        }
    }

    return results;
}
