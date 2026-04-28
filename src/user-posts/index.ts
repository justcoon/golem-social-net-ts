import {
  BaseAgent,
  Result,
  agent,
  prompt,
  description,
  endpoint,
} from "@golemcloud/golem-ts-sdk";

import { Timestamp, ErrorResponse } from "../common/types";
import { getCurrentTimestamp } from "../common/utils";

import { parseQuery } from "../common/query";
import { serialize, deserialize } from "../common/snapshot";
import { Post, PostAgent, fetchPostsByIds } from "../post/index";

export interface PostRef {
  postId: string;
  createdAt: Timestamp;
}

export interface UserPosts {
  userId: string;
  posts: PostRef[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserPostsUpdates {
  userId: string;
  posts: PostRef[];
}

export function initUserPostsState(userId: string, now: Timestamp): UserPosts {
  return {
    userId,
    posts: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function addUserPost(
  state: UserPosts,
  postId: string,
  now: Timestamp,
): PostRef {
  const postRef: PostRef = {
    postId: postId,
    createdAt: now,
  };

  state.updatedAt = now;
  state.posts.push(postRef);

  return postRef;
}

@agent({ mount: '/v1/social-net/users/{id}/posts' })
export class UserPostsAgent extends BaseAgent {
  private readonly _id: string;
  private state: UserPosts | null = null;

  constructor(id: string) {
    super();
    this._id = id;
  }

  private getState(): UserPosts {
    if (this.state === null) {
      this.state = initUserPostsState(this._id, getCurrentTimestamp());
    }
    return this.state;
  }

  @prompt("Get posts")
  @description("Returns the posts for the user")
  @endpoint({ get: '/' })
  async getPosts(): Promise<UserPosts | null> {
    return this.state;
  }

  @prompt("Get updates")
  @description("Returns post updates since a given time")
  async getUpdates(updatesSince: Timestamp): Promise<UserPostsUpdates | null> {
    if (this.state !== null) {
      console.log(`get updates - updates since: ${updatesSince.timestamp}`);
      const since = updatesSince;

      const updates = this.state.posts.filter(
        (p) => p.createdAt.timestamp > since.timestamp,
      );
      return {
        userId: this.state.userId,
        posts: updates,
      };
    }
    return null;
  }

  @prompt("Create post")
  @description("Creates a new post with content")
  @endpoint({ post: '/' })
  async createPost(content: string): Promise<Result<PostRef, ErrorResponse>> {
    const state = this.getState();

    // Note: Generate uuid natively or via lib
    const postId = crypto.randomUUID();
    console.log(`create post - id: ${postId}`);

    const now = getCurrentTimestamp();
    const post = addUserPost(state, postId, now);

    PostAgent.get(postId).initPost.trigger(state.userId, content);

    return Result.ok(post);
  }

  override async saveSnapshot(): Promise<Uint8Array> {
    return serialize(this.state);
  }

  override async loadSnapshot(bytes: Uint8Array): Promise<void> {
    if (bytes.length > 0) {
      const raw = deserialize<UserPosts>(bytes);
      this.state = raw;
    }
  }
}

@agent({ 
  mode: "ephemeral",
  mount: '/v1/social-net/users'
})
export class UserPostsViewAgent extends BaseAgent {
  constructor() {
    super();
  }

  @prompt("Get posts view")
  @description("Returns fetched and filtered posts")
  @endpoint({ get: '/{userId}/posts/search?query={query}' })
  async getPostsView(userId: string, query: string): Promise<Post[] | null> {
    const userPosts = await UserPostsAgent.get(userId).getPosts();

    console.log(`get posts view - user id: ${userId}, query: ${query}`);

    if (userPosts !== null) {
      const parsedQuery = parseQuery(query);
      const postIds = userPosts.posts.map((p) => p.postId);
      if (postIds.length === 0) {
        return [];
      } else {
        return await fetchPostsByIds(postIds, parsedQuery);
      }
    } else {
      return null;
    }
  }

  @prompt("Get posts updates view")
  @description("Returns updated fetched posts")
  @endpoint({ get: '/{userId}/posts/updates?since={since}' })
  async getPostsUpdatesView(
    userId: string,
    since: string | null,
  ): Promise<Post[] | null> {
    const userPostsUpdates =
      await UserPostsAgent.get(userId).getUpdates(since ? { timestamp: since } : getCurrentTimestamp());

    console.log(
      `get posts updates view - user id: ${userId}, updates since: ${since}`,
    );

    if (userPostsUpdates !== null) {
      const postIds = userPostsUpdates.posts.map((p) => p.postId);
      if (postIds.length === 0) {
        return [];
      } else {
        return await fetchPostsByIds(postIds, undefined);
      }
    } else {
      return null;
    }
  }
}
