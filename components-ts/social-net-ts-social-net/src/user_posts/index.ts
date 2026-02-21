import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';

import { Query } from '../common/query';
import { serialize, deserialize } from '../common/snapshot';
import { Post, PostAgent, matchesPost, fetchPostsByIds } from '../post/index';

export interface PostRef {
    postId: string;
    createdAt: number;
}

export interface UserPosts {
    userId: string;
    posts: PostRef[];
    createdAt: number;
    updatedAt: number;
}

export interface UserPostsUpdates {
    userId: string;
    posts: PostRef[];
}

@agent()
export class UserPostsAgent extends BaseAgent {
    private readonly _id: string;
    private state: UserPosts | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): UserPosts {
        if (this.state === null) {
            const now = Date.now();
            this.state = {
                userId: this._id,
                posts: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Get posts")
    @description("Returns the posts for the user")
    async getPosts(): Promise<UserPosts | null> {
        return this.state;
    }

    @prompt("Get updates")
    @description("Returns post updates since a given time")
    async getUpdates(updatesSince: number): Promise<UserPostsUpdates | null> {
        if (this.state !== null) {
            console.log(`get updates - updates since: ${updatesSince.toString()}`);
            const sinceMs = updatesSince;

            const updates = this.state.posts.filter(p => p.createdAt > sinceMs);
            return {
                userId: this.state.userId,
                posts: updates
            };
        }
        return null;
    }

    @prompt("Create post")
    @description("Creates a new post with content")
    async createPost(content: string): Promise<Result<string, string>> {
        const state = this.getState();

        // Note: Generate uuid natively or via lib
        const postId = crypto.randomUUID();
        console.log(`create post - id: ${postId}`);

        const postRef: PostRef = {
            postId: postId,
            createdAt: Date.now()
        };

        PostAgent.get(postId).initPost.trigger(state.userId, content);

        state.updatedAt = postRef.createdAt;
        state.posts.push(postRef);

        return Result.ok(postId);
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<UserPosts>(bytes);
            if (raw) {
                this.state = raw;
            } else {
                this.state = null;
            }
        }
    }
}

class PostQueryMatcher {
    public readonly query: Query;

    constructor(queryStr: string) {
        this.query = new Query(queryStr);
    }

    public matchesPost(post: Post): boolean {
        return matchesPost(post, this.query);
    }
}

@agent({ mode: "ephemeral" })
export class UserPostsViewAgent extends BaseAgent {
    constructor() {
        super();
    }

    @prompt("Get posts view")
    @description("Returns fetched and filtered posts")
    async getPostsView(userId: string, query: string): Promise<Post[] | null> {
        const userPosts = await UserPostsAgent.get(userId).getPosts();

        console.log(`get posts view - user id: ${userId}, query: ${query}`);

        if (userPosts !== null) {
            const queryMatcher = new PostQueryMatcher(query);
            const postRefs = userPosts.posts;

            if (postRefs.length === 0) {
                return [];
            } else {
                const postIds = postRefs.map(p => p.postId);
                const posts = await fetchPostsByIds(postIds);

                return posts.filter(p => queryMatcher.matchesPost(p));
            }
        } else {
            return null;
        }
    }

    @prompt("Get posts updates view")
    @description("Returns updated fetched posts")
    async getPostsUpdatesView(userId: string, updatesSince: number): Promise<Post[] | null> {
        const userPostsUpdates = await UserPostsAgent.get(userId).getUpdates(updatesSince);

        console.log(`get posts updates view - user id: ${userId}, updates since: ${updatesSince.toString()}`);

        if (userPostsUpdates !== null) {
            const updatedPostRefs = userPostsUpdates.posts;

            if (updatedPostRefs.length === 0) {
                return [];
            } else {
                const postIds = updatedPostRefs.map(p => p.postId);
                return await fetchPostsByIds(postIds);
            }
        } else {
            return null;
        }
    }
}
