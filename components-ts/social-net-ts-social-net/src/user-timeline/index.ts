import {
    BaseAgent,
    Result,
    agent,
    prompt,
    description,
} from '@golemcloud/golem-ts-sdk';

import { UserConnectionType, Timestamp } from '../common/types';
import { Query, optTextExactMatches, textExactMatches } from '../common/query';
import { serialize, deserialize } from '../common/snapshot';
import { getCurrentTimestamp } from '../common/utils';
import { pollForUpdates } from '../common/poll';
import { Post, PostAgent, matchesPost, fetchPostsByIds } from '../post/index';

const POSTS_MAX_COUNT = 500;

export interface PostRef {
    postId: string;
    createdBy: string;
    createdByConnectionType: UserConnectionType | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserTimeline {
    userId: string;
    posts: PostRef[];
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface UserTimelineUpdates {
    userId: string;
    posts: PostRef[];
}

@agent()
export class UserTimelineAgent extends BaseAgent {
    private readonly _id: string;
    private state: UserTimeline | null = null;

    constructor(id: string) {
        super();
        this._id = id;
    }

    private getState(): UserTimeline {
        if (this.state === null) {
            const now = getCurrentTimestamp();
            this.state = {
                userId: this._id,
                posts: [],
                createdAt: now,
                updatedAt: now
            };
        }
        return this.state;
    }

    @prompt("Get timeline")
    @description("Returns the timeline posts for the user")
    async getTimeline(): Promise<UserTimeline | null> {
        return this.state;
    }

    @prompt("Get updates")
    @description("Returns timeline updates since a given time")
    async getUpdates(updatesSince: Timestamp): Promise<UserTimelineUpdates | null> {
        if (this.state !== null) {
            console.log(`get updates - updates since: ${updatesSince.timestamp}`);
            const since = updatesSince;

            const updates = this.state.posts.filter(p => p.updatedAt.timestamp > since.timestamp);
            return {
                userId: this.state.userId,
                posts: updates
            };
        }
        return null;
    }

    @prompt("Posts updated")
    @description("Triggered when posts are updated to be added/modified on the timeline")
    async postsUpdated(posts: PostRef[]): Promise<Result<null, string>> {
        const state = this.getState();
        console.log(`posts updated - count: ${posts.length}`);

        const ids = new Set(posts.map(p => p.postId));

        state.posts = state.posts.filter(p => !ids.has(p.postId));
        state.posts.push(...posts);

        state.posts.sort((a, b) => b.updatedAt.timestamp.localeCompare(a.updatedAt.timestamp));

        if (state.posts.length > POSTS_MAX_COUNT) {
            state.posts = state.posts.slice(0, POSTS_MAX_COUNT);
        }

        state.updatedAt = getCurrentTimestamp();
        return Result.ok(null);
    }

    override async saveSnapshot(): Promise<Uint8Array> {
        return serialize(this.state);
    }

    override async loadSnapshot(bytes: Uint8Array): Promise<void> {
        if (bytes.length > 0) {
            const raw = deserialize<UserTimeline>(bytes);
            this.state = raw;
        }
    }
}

class PostQueryMatcher {
    public readonly query: Query;

    constructor(queryStr: string) {
        this.query = new Query(queryStr);
    }

    public matchesPostRef(postRef: PostRef): boolean {
        for (const [field, value] of this.query.fieldFilters) {
            let matches = false;
            switch (field.toLowerCase()) {
                case "connection-type":
                case "connectiontype":
                    matches = optTextExactMatches(postRef.createdByConnectionType, value);
                    break;
                case "created-by":
                case "createdby":
                    matches = textExactMatches(postRef.createdBy, value);
                    break;
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

    public matchesPost(post: Post): boolean {
        return matchesPost(post, this.query);
    }
}

@agent({ mode: "ephemeral" })
export class UserTimelineViewAgent extends BaseAgent {
    constructor() {
        super();
    }

    @prompt("Get posts view")
    @description("Returns fetched and filtered timeline posts")
    async getPostsView(userId: string, query: string): Promise<Post[] | null> {
        const timelinePosts = await UserTimelineAgent.get(userId).getTimeline();

        console.log(`get posts view - user id: ${userId}, query: ${query}`);

        if (timelinePosts !== null) {
            const queryMatcher = new PostQueryMatcher(query);

            const postIds = timelinePosts.posts
                .filter(p => queryMatcher.matchesPostRef(p))
                .map(p => p.postId);

            if (postIds.length === 0) {
                return [];
            } else {
                const posts = await fetchPostsByIds(postIds);

                return posts.filter(p => queryMatcher.matchesPost(p));
            }
        } else {
            return null;
        }
    }

    @prompt("Get posts updates view")
    @description("Returns updated fetched timeline posts")
    async getPostsUpdatesView(userId: string, updatesSince: Timestamp): Promise<Post[] | null> {
        const timelineUpdates = await UserTimelineAgent.get(userId).getUpdates(updatesSince);

        console.log(`get posts updates view - user id: ${userId}, updates since: ${updatesSince.timestamp}`);

        if (timelineUpdates !== null) {
            const updatedPostRefs = timelineUpdates.posts;

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

@agent({ mode: "ephemeral" })
export class UserTimelineUpdatesAgent extends BaseAgent {
    constructor() {
        super();
    }

    @prompt("Get posts updates")
    @description("Polls and retrieves timeline post updates for a user")
    async getPostsUpdates(
        userId: string,
        updatesSince: Timestamp | null,
        iterWaitTime: number | null,
        maxWaitTime: number | null
    ): Promise<PostRef[] | null> {
        const uSince = updatesSince ?? undefined;
        const iWait = iterWaitTime ?? undefined;
        const mWait = maxWaitTime ?? undefined;

        const res = await pollForUpdates<PostRef>(
            userId,
            uSince,
            iWait,
            mWait,
            async (uid, since) => {
                const updates = await UserTimelineAgent.get(uid).getUpdates(since);
                return updates ? updates.posts : undefined;
            },
            "get posts updates"
        );
        return res ?? null;
    }
}
