import {
  BaseAgent,
  Result,
  agent,
  prompt,
  description,
  endpoint,
} from "@golemcloud/golem-ts-sdk";
import { v4 as uuidv4 } from "uuid";

import { LikeType, Timestamp, ErrorResponse } from "../common/types";
import { Query, textExactMatches, textMatches } from "../common/query";
import { serialize, deserialize } from "../common/snapshot";
import { arrayChunks, getCurrentTimestamp } from "../common/utils";
import { UserAgent } from "../user/index";
import { PostRef, UserTimelineAgent } from "../user-timeline/index";

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

export interface AddCommentResponse {
  postId: string;
  commentId: string;
}

export interface UpdateResponse {
  postId: string;
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

export function postMatchesQuery(post: Post, query: Query): boolean {
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
        matches = post.comments.some(([_, comment]) =>
          textMatches(comment.content, value),
        );
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
    query.terms.some((term) => {
      const matchesContent = textMatches(post.content, term);
      const matchesComments = post.comments.some(([_, comment]) =>
        textMatches(comment.content, term),
      );
      return matchesContent || matchesComments;
    })
  );
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

export function initPostUpdates(userId: string, now: Timestamp): PostUpdates {
  return {
    userId,
    updates: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updatePostUpdates(
  state: PostUpdates,
  update: PostUpdate,
  now: Timestamp,
): void {
  state.updates = state.updates.filter((u) => u.postId !== update.postId);
  state.updates.push(update);
  state.updatedAt = now;
}

export function clearPostUpdates(
  state: PostUpdates,
  now: Timestamp,
): PostUpdate[] {
  const updates = [...state.updates];
  state.updates = [];
  state.updatedAt = now;
  return updates;
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
      this.state = initPostUpdates(this._id, getCurrentTimestamp());
    }
    return this.state;
  }

  @prompt("Trigger post updated")
  @description("Trigger timelines update on post creation or modifications")
  async postUpdated(
    update: PostUpdate,
    processImmediately: boolean,
  ): Promise<void> {
    console.log(
      `timelines updater - user: ${this._id}, post: ${update.postId}`,
    );
    updatePostUpdates(this.getState(), update, getCurrentTimestamp());

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

    console.log(
      `posts updates - user id: ${this._id} - updates: ${state.updates.length} - processing ...`,
    );

    const user = await UserAgent.get(this._id).getUser();
    if (user) {
      const updates = clearPostUpdates(state, getCurrentTimestamp());

      const connectedUsers = user.connectedUsers;
      const postRefs: PostRef[] = updates.map((u) => ({
        postId: u.postId,
        createdBy: this._id,
        createdByConnectionType: null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      }));

      // Update user's own timeline
      UserTimelineAgent.get(this._id).postsUpdated.trigger(postRefs);

      // Update connected users' timelines
      for (const cuTuple of connectedUsers) {
        const cu = cuTuple[1];
        for (const ct of cu.connectionTypes) {
          const notifyPostRefs = updates.map((u) => ({
            postId: u.postId,
            createdBy: this._id,
            createdByConnectionType: ct,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
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
      this.state = raw;
    }
  }
}

export function initPostState(postId: string, now: Timestamp): Post {
  return {
    postId,
    content: "",
    createdBy: "",
    likes: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function initializePostAgent(
  post: Post,
  createdBy: string,
  content: string,
): void {
  post.createdBy = createdBy;
  post.content = content;
}

export function setPostLike(
  post: Post,
  userId: string,
  likeType: LikeType,
  now: Timestamp,
): void {
  post.likes = post.likes.filter((l) => l[0] !== userId);
  post.likes.push([userId, likeType]);
  post.updatedAt = now;
}

export function removePostLike(
  post: Post,
  userId: string,
  now: Timestamp,
): Result<null, ErrorResponse> {
  const initialLength = post.likes.length;
  post.likes = post.likes.filter((l) => l[0] !== userId);

  if (post.likes.length !== initialLength) {
    post.updatedAt = now;
    return Result.ok(null);
  } else {
    return Result.err({ message: "Like not found" });
  }
}

export function addPostComment(
  post: Post,
  userId: string,
  content: string,
  parentCommentId: string | null,
  now: Timestamp,
): Result<string, ErrorResponse> {
  if (post.comments.length >= MAX_COMMENTS_LENGTH) {
    return Result.err({ message: "Max comments limit reached" });
  }

  const cid = uuidv4();
  post.comments.push([
    cid,
    {
      commentId: cid,
      parentCommentId,
      content,
      likes: [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  post.updatedAt = now;

  return Result.ok(cid);
}

export function removePostComment(
  post: Post,
  commentId: string,
  now: Timestamp,
): Result<null, ErrorResponse> {
  const initialLength = post.comments.length;
  post.comments = post.comments.filter(
    (c) => c[0] !== commentId && c[1].parentCommentId !== commentId,
  );

  if (post.comments.length !== initialLength) {
    post.updatedAt = now;
    return Result.ok(null);
  } else {
    return Result.err({ message: "Comment not found" });
  }
}

export function setPostCommentLike(
  post: Post,
  commentId: string,
  userId: string,
  likeType: LikeType,
  now: Timestamp,
): Result<null, ErrorResponse> {
  const commentTuple = post.comments.find((c) => c[0] === commentId);
  if (commentTuple) {
    const comment = commentTuple[1];
    comment.likes = comment.likes.filter((l) => l[0] !== userId);
    comment.likes.push([userId, likeType]);
    comment.updatedAt = now;
    post.updatedAt = now;
    return Result.ok(null);
  } else {
    return Result.err({ message: "Comment not found" });
  }
}

export function removePostCommentLike(
  post: Post,
  commentId: string,
  userId: string,
  now: Timestamp,
): Result<null, ErrorResponse> {
  const commentTuple = post.comments.find((c) => c[0] === commentId);
  if (commentTuple) {
    const comment = commentTuple[1];
    const initialLikes = comment.likes.length;
    comment.likes = comment.likes.filter((l) => l[0] !== userId);

    if (comment.likes.length !== initialLikes) {
      comment.updatedAt = now;
      post.updatedAt = now;
      return Result.ok(null);
    }
  }
  return Result.err({ message: "Comment not found" });
}

@agent({ mount: '/v1/social-net/posts/{id}' })
export class PostAgent extends BaseAgent {
  private readonly _id: string;
  private state: Post | null = null;

  constructor(id: string) {
    super();
    this._id = id;
  }

  private getState(): Post {
    if (this.state === null) {
      this.state = initPostState(this._id, getCurrentTimestamp());
    }
    return this.state;
  }

  @prompt("Get the post")
  @description("Returns the post details")
  @endpoint({ get: '/' })
  async getPost(): Promise<Post | null> {
    return this.state;
  }

  @prompt("Get post if matches query")
  @description("Returns the post if it matches the query, null otherwise")
  async getPostIfMatch(query: Query): Promise<Post | null> {
    return this.state && postMatchesQuery(this.state, query) ? this.state : null;
  }

  @prompt("Initialize the post")
  @description("Initializes a new post with content and author")
  async initPost(
    createdBy: string,
    content: string,
  ): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state !== null) {
      return Result.err({ message: "Post already exists" });
    }

    const state = this.getState();
    console.log(`init post - created by: ${createdBy}, content: ${content} `);

    initializePostAgent(state, createdBy, content);

    TimelinesUpdaterAgent.get(createdBy).postUpdated.trigger(
      {
        postId: state.postId,
        createdAt: state.createdAt,
        updatedAt: state.createdAt,
      },
      true,
    );

    return Result.ok({ postId: state.postId });
  }

  @prompt("Set like on the post")
  @description("Sets a like for the post")
  @endpoint({ put: '/likes' })
  async setLike(userId: string, likeType: LikeType): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }
    const state = this.getState();
    console.log(`set like - user id: ${userId}, like type: ${likeType}`);
    setPostLike(state, userId, likeType, getCurrentTimestamp());
    return Result.ok({ postId: state.postId });
  }

  @prompt("Remove like from the post")
  @description("Removes a like from the post")
  @endpoint({ delete: '/likes/{userId}' })
  async removeLike(userId: string): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }

    const state = this.getState();
    console.log(`remove like - user id: ${userId} `);
    return removePostLike(state, userId, getCurrentTimestamp())
      .map(() => ({ postId: state.postId }));
  }

  @prompt("Add a comment")
  @description("Adds a new comment to the post")
  @endpoint({ post: '/comments' })
  async addComment(userId: string, content: string, parentCommentId: string | null): Promise<Result<AddCommentResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }

    const state = this.getState();
    console.log(`add comment - user id: ${userId}, content: ${content} `);
    const res = addPostComment(
      state,
      userId,
      content,
      parentCommentId,
      getCurrentTimestamp(),
    );

    if (res.isOk()) {
      return Result.ok({ postId: state.postId, commentId: res.val });
    } else {
      return res;
    }
  }

  @prompt("Remove a comment")
  @description("Removes a comment from the post")
  @endpoint({ delete: '/comments/{commentId}' })
  async removeComment(commentId: string): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }

    const state = this.getState();
    console.log(`remove comment - comment id: ${commentId} `);
    return removePostComment(state, commentId, getCurrentTimestamp())
      .map(() => ({ postId: state.postId }));
  }

  @prompt("Set like on a comment")
  @description("Sets a like for a comment")
  @endpoint({ put: '/comments/{commentId}/likes' })
  async setCommentLike(
    commentId: string,
    userId: string,
    likeType: LikeType,
  ): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }

    const state = this.getState();
    console.log(
      `set comment like - comment id: ${commentId}, user id: ${userId}, like type: ${likeType}`,
    );
    return setPostCommentLike(
      state,
      commentId,
      userId,
      likeType,
      getCurrentTimestamp(),
    ).map(() => ({ postId: state.postId }));
  }

  @prompt("Remove like from a comment")
  @description("Removes a like from a comment")
  @endpoint({ delete: '/comments/{commentId}/likes/{userId}' })
  async removeCommentLike(
    commentId: string,
    userId: string,
  ): Promise<Result<UpdateResponse, ErrorResponse>> {
    if (this.state === null) {
      return Result.err({ message: "Post not exists" });
    }

    const state = this.getState();
    console.log(
      `remove comment like - comment id: ${commentId}, user id: ${userId} `,
    );
    return removePostCommentLike(
      state,
      commentId,
      userId,
      getCurrentTimestamp(),
    ).map(() => ({ postId: state.postId }));
  }

  override async saveSnapshot(): Promise<Uint8Array> {
    return serialize(this.state);
  }

  override async loadSnapshot(bytes: Uint8Array): Promise<void> {
    if (bytes.length > 0) {
      const raw = deserialize<Post>(bytes);
      this.state = raw;
    }
  }
}

export async function fetchPostsByIds(
  postIds: string[],
  query?: Query,
): Promise<Post[]> {
  const results: Post[] = [];
  const chunks = arrayChunks(postIds, 10);

  for (const chunk of chunks) {
    const promises = chunk.map((id) =>
      query
        ? PostAgent.get(id).getPostIfMatch(query)
        : PostAgent.get(id).getPost(),
    );
    const postsOptions = await Promise.all(promises);
    for (const p of postsOptions) {
      if (p) {
        results.push(p);
      }
    }
  }

  return results;
}
