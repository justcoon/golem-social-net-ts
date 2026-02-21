export enum UserConnectionType {
    Friend = "Friend",
    Follower = "Follower",
    Following = "Following",
}

export function getOppositeConnectionType(type: UserConnectionType): UserConnectionType {
    switch (type) {
        case UserConnectionType.Follower:
            return UserConnectionType.Following;
        case UserConnectionType.Following:
            return UserConnectionType.Follower;
        case UserConnectionType.Friend:
            return UserConnectionType.Friend;
    }
}

export enum LikeType {
    Like = "Like",
    Insightful = "Insightful",
    Love = "Love",
    Dislike = "Dislike",
}

export function isPositiveLike(type: LikeType): boolean {
    return !isNegativeLike(type);
}

export function isNegativeLike(type: LikeType): boolean {
    return type === LikeType.Dislike;
}
